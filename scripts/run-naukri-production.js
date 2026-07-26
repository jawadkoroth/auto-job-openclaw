const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const eventBus = require("../packages/events/EventBus");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const resumeManager = require("../packages/resume/ResumeManager");

// Safe process-level delay utility (does not depend on Playwright page/browser state)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TARGET_SEARCH_URLS = [
    "https://www.naukri.com/devops-jobs-in-bangalore",
    "https://www.naukri.com/cloud-engineer-jobs-in-bangalore",
    "https://www.naukri.com/platform-engineer-jobs-in-bangalore",
    "https://www.naukri.com/infrastructure-engineer-jobs-in-bangalore",
    "https://www.naukri.com/aws-jobs-in-bangalore",
    "https://www.naukri.com/site-reliability-engineer-jobs-in-bangalore"
];

const MAX_APPLICATIONS_PER_RUN = parseInt(process.env.NAUKRI_MAX_APPLICATIONS_PER_RUN || process.env.MAX_APPLICATIONS_PER_RUN || "10", 10);
const MAX_APPLICATIONS_PER_DAY = parseInt(process.env.NAUKRI_MAX_APPLICATIONS_PER_DAY || process.env.MAX_APPLICATIONS_PER_DAY || "20", 10);

(async () => {
    const isDryRun = process.argv.includes("--dry-run");

    logger.info("==================================================");
    logger.info("NAUKRI PRODUCTION AUTOMATION RUNNER");
    logger.info(`Mode: ${isDryRun ? "DRY RUN (No Applications Submitted)" : "ACTIVE PRODUCTION (Live Submissions)"}`);
    logger.info(`Execution Time: ${new Date().toISOString()}`);
    logger.info(`Limits: Max ${MAX_APPLICATIONS_PER_RUN} per run, Max ${MAX_APPLICATIONS_PER_DAY} per day`);
    logger.info("==================================================\n");

    await db.init();
    const candidateProfile = await candidateProfileService.getProfile().catch(() => ({}));

    const telemetry = {
        timestamp: new Date().toISOString(),
        isDryRun,
        discoveryStatus: "UNKNOWN",
        Discovered: 0,
        RoleEligible: 0,
        ExperienceEligible: 0,
        LocationEligible: 0,
        Duplicates: 0,
        AlreadyApplied: 0,
        Ranked: 0,
        FinalCandidates: 0,
        Attempted: 0,
        Applied: 0,
        WaitingForInput: 0,
        ExternalRequired: 0,
        Failed: 0,
        SkippedQualityGate: 0,
        zeroApplicationReason: null,
        dailyLimit: MAX_APPLICATIONS_PER_DAY,
        dailyAppliedCount: 0,
        dailyRemainingCapacity: 0
    };

    const saveTelemetry = () => {
        try {
            const sessionPath = path.join(process.cwd(), "sessions", "naukri");
            fs.mkdirpSync(sessionPath);
            fs.writeJsonSync(path.join(sessionPath, "last_run_telemetry.json"), telemetry, { spaces: 2 });
        } catch (e) {}
    };

    // Calculate daily successful applications count from SQLite using correct IST modifier query
    const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
    const appliedTodayRow = await db.get(
        "SELECT COUNT(*) as count FROM jobs WHERE LOWER(portal) = 'naukri' AND applied = 1 AND DATE(datetime(COALESCE(updated_at, timestamp), '+5 hours', '+30 minutes')) = ?",
        [todayIst]
    );
    const appliedToday = appliedTodayRow ? appliedTodayRow.count : 0;
    telemetry.dailyAppliedCount = appliedToday;
    telemetry.dailyRemainingCapacity = Math.max(0, MAX_APPLICATIONS_PER_DAY - appliedToday);

    logger.info(`Daily Naukri Applications Counter (IST: ${todayIst}): ${appliedToday} / ${MAX_APPLICATIONS_PER_DAY} (Remaining: ${telemetry.dailyRemainingCapacity})`);

    if (appliedToday >= MAX_APPLICATIONS_PER_DAY && !isDryRun) {
        logger.warn("⚠️ Daily Naukri application limit reached. Skipping further submissions today.");
        telemetry.zeroApplicationReason = "DAILY_LIMIT_REACHED";
        saveTelemetry();
        process.exit(0);
    }

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    if (!fs.existsSync(storageStatePath)) {
        logger.error("❌ Saved Naukri session missing or expired: sessions/naukri/storageState.json not found.");
        const telegramService = require("../apps/telegram");
        await telegramService.sendMessage(
            "<b>⚠️ Naukri Authentication Required</b>\n\n" +
            "• <b>Portal</b>: <code>Naukri</code>\n" +
            "• <b>Condition</b>: <code>SESSION_EXPIRED</code>\n" +
            "• <b>Details</b>: Saved Naukri session missing or expired on Oracle VM.\n" +
            "• <b>Action</b>: Manual session refresh required via <code>node scripts/setup-naukri-session.js</code>."
        ).catch(() => {});

        telemetry.zeroApplicationReason = "AUTH_EXPIRED";
        saveTelemetry();
        process.exit(0);
    }

    let browser = null;
    let context = null;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });

        context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });

        // 1. Session Health Check (Dedicated Auth Health Check Page)
        logger.info("[1/4] Verifying Authenticated Naukri Session...");
        const healthPage = await context.newPage();
        await healthPage.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await delay(2000);

        const currentUrl = healthPage.url();
        const isLoginRedirect = currentUrl.includes("/nlogin/") || currentUrl.includes("/login");
        await healthPage.close().catch(() => {}); // Close health check page safely

        if (isLoginRedirect) {
            logger.error("❌ Naukri session redirect detected. Re-authentication required.");
            const telegramService = require("../apps/telegram");
            await telegramService.sendMessage(
                "<b>⚠️ Naukri Session Reauth Required</b>\n\n" +
                "• <b>Portal</b>: <code>Naukri</code>\n" +
                "• <b>Condition</b>: <code>SESSION_REAUTH_REQUIRED</code>\n" +
                "• <b>Timestamp</b>: <code>" + new Date().toISOString() + "</code>\n" +
                "• <b>Final URL</b>: <code>" + currentUrl + "</code>\n" +
                "• <b>Action</b>: Application run halted safely. Preserving existing job states."
            ).catch(() => {});

            telemetry.zeroApplicationReason = "AUTH_EXPIRED";
            saveTelemetry();
            process.exit(0);
        }
        logger.info("✓ Authenticated Naukri Session Verified.");

        // 2. Fresh Dedicated Page for Job Discovery (Prevents SPA cross-origin referrer blocks)
        logger.info("\n[2/4] Executing Fresh Job Discovery across target searches...");
        const discoveryPage = await context.newPage();
        const rawDiscoveredJobs = [];
        const seenIds = new Set();
        let blockedSearchCount = 0;
        let successfulSearchCount = 0;

        for (let sIdx = 0; sIdx < TARGET_SEARCH_URLS.length; sIdx++) {
            const searchUrl = TARGET_SEARCH_URLS[sIdx];
            logger.info(`Searching (${sIdx + 1}/${TARGET_SEARCH_URLS.length}): ${searchUrl}`);

            if (sIdx > 0) {
                const searchDelay = Math.floor(Math.random() * 2000) + 3000;
                await delay(searchDelay); // Safe process-level delay
            }

            let res = null;
            let navSuccess = false;
            try {
                res = await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await delay(3000);
                navSuccess = true;
            } catch (navErr) {
                logger.warn(`Navigation error on ${searchUrl}: ${navErr.message}`);
            }

            if (!navSuccess) {
                blockedSearchCount++;
                continue;
            }

            const title = await discoveryPage.title().catch(() => "");
            const status = res ? res.status() : 0;
            const isAccessDenied = status === 403 || title.toLowerCase().includes("access denied");

            if (isAccessDenied) {
                logger.warn(`⚠️ Akamai 403 Access Denied on ${searchUrl}. Backing off...`);
                blockedSearchCount++;
                await delay(5000); // Process-level safe delay
                continue;
            }

            successfulSearchCount++;

            // Resilient Selector Matrix
            const jobSelector = ".cust-job-tuple, article.jobTuple, div.srp-jobtuple, article.srp-jobtuple, [data-job-id]";
            await discoveryPage.waitForSelector(jobSelector + ", a.title", { timeout: 15000 }).catch(() => {});

            const cards = discoveryPage.locator(jobSelector);
            let count = await cards.count().catch(() => 0);

            if (count === 0) {
                const titleLinks = discoveryPage.locator("a.title, a[href*='job-listings']");
                count = await titleLinks.count().catch(() => 0);
            }

            logger.info(`Found ${count} job cards on ${searchUrl}`);

            for (let i = 0; i < count; i++) {
                try {
                    const item = cards.nth(i);
                    const titleLoc = (await item.count().catch(() => 0) > 0)
                        ? item.locator("a.title, .title, [class*='title']").first()
                        : discoveryPage.locator("a.title, a[href*='job-listings']").nth(i);

                    const titleText = (await titleLoc.textContent().catch(() => "")).trim();
                    const url = await titleLoc.getAttribute("href").catch(() => "");
                    if (!titleText || !url) continue;

                    const companyLoc = item.locator(".companyName, .company, a.comp-name, [class*='company']").first();
                    const company = (await companyLoc.count().catch(() => 0) > 0)
                        ? (await companyLoc.textContent().catch(() => "Naukri Employer")).trim()
                        : "Naukri Employer";

                    // Extract Job ID
                    let jobId = await item.getAttribute("data-job-id").catch(() => null);
                    if (!jobId && url) {
                        const match = url.match(/-([0-9]{12})\b/);
                        if (match) jobId = match[1];
                        else jobId = url.split("?")[0].split("/").pop();
                    }
                    if (!jobId) jobId = `naukri_${Date.now()}_${i}`;

                    if (seenIds.has(jobId)) continue;
                    seenIds.add(jobId);
                    telemetry.Discovered++;

                    // Role Filtering
                    const titleLower = titleText.toLowerCase();
                    const isArchitectOrManager = titleLower.includes("architect") || titleLower.includes("manager") || titleLower.includes("director") || titleLower.includes("designer") || titleLower.includes("full stack");
                    const isDevOpsTarget = titleLower.includes("devops") || titleLower.includes("cloud") || titleLower.includes("platform") || titleLower.includes("infrastructure") || titleLower.includes("sre") || titleLower.includes("kubernetes") || titleLower.includes("aws") || titleLower.includes("site reliability") || titleLower.includes("ci/cd");

                    if (isArchitectOrManager || !isDevOpsTarget) continue;
                    telemetry.RoleEligible++;

                    // Experience Filtering (jobMin <= 6 AND jobMax >= 1)
                    const expLoc = item.locator(".expwdde, .experience, span.exp, span.exp-wrap, [class*='experience']").first();
                    const experience = (await expLoc.count() > 0) ? (await expLoc.textContent().catch(() => "0-3 Yrs")).trim() : "0-3 Yrs";

                    const expCheck = checkExperienceEligibility(experience);
                    if (!expCheck.eligible) continue;
                    telemetry.ExperienceEligible++;

                    // Location Filtering
                    const locLoc = item.locator(".locWd, .location, span.loc, span.loc-wrap, [class*='location']").first();
                    const location = (await locLoc.count() > 0) ? (await locLoc.textContent().catch(() => "Bangalore")).trim() : "Bangalore";

                    const locCheck = checkLocationEligibility(location, titleText);
                    if (!locCheck.eligible) continue;
                    telemetry.LocationEligible++;

                    // Database Duplicates Check
                    const dbRecord = await db.get("SELECT * FROM jobs WHERE LOWER(portal) = 'naukri' AND (job_id = ? OR url = ?)", [jobId, url]);
                    if (dbRecord) {
                        telemetry.Duplicates++;
                        if (dbRecord.applied === 1 || ["APPLIED", "EMPLOYER_PENDING", "APPLICATION_SUBMITTED", "INTERVIEW_REQUESTED"].includes(dbRecord.status)) {
                            telemetry.AlreadyApplied++;
                            continue;
                        }
                    }

                    rawDiscoveredJobs.push({
                        jobId,
                        title: titleText,
                        company,
                        location,
                        experience,
                        url
                    });

                } catch (cardErr) {}
            }
        }

        await discoveryPage.close().catch(() => {}); // Close discovery page cleanly

        // PHASE 5 — DISCOVERY ANOMALY & BLOCKED HANDLING
        if (blockedSearchCount === TARGET_SEARCH_URLS.length) {
            logger.error("❌ DISCOVERY_BLOCKED: All configured target search URLs were blocked by Akamai 403!");
            telemetry.discoveryStatus = "DISCOVERY_BLOCKED";
            telemetry.zeroApplicationReason = "DISCOVERY_BLOCKED";
            saveTelemetry();

            const telegramService = require("../apps/telegram");
            await telegramService.sendMessage(
                "<b>⚠️ Naukri Discovery Blocked Alert</b>\n\n" +
                "• <b>Portal</b>: <code>Naukri</code>\n" +
                "• <b>Status</b>: <code>DISCOVERY_BLOCKED</code>\n" +
                "• <b>Details</b>: All configured search URLs returned 403 Access Denied on Oracle VM.\n" +
                "• <b>Action</b>: Application run halted safely. Zero applications attempted."
            ).catch(() => {});

            process.exit(0);
        }

        if (telemetry.Discovered === 0 && blockedSearchCount === 0) {
            logger.info("✓ DISCOVERY_SUCCESS_ZERO_RESULTS: Search completed cleanly. No new job cards found.");
            telemetry.discoveryStatus = "DISCOVERY_SUCCESS_ZERO_RESULTS";
            telemetry.zeroApplicationReason = "NO_MATCHING_JOBS";
            saveTelemetry();
            process.exit(0);
        }

        telemetry.discoveryStatus = blockedSearchCount > 0 ? "DISCOVERY_PARTIAL" : "DISCOVERY_SUCCESS";

        // PHASE 2 & 3 — INTELLIGENT JOB RANKING
        logger.info("\n[3/4] Running Intelligent Job Ranking Engine on eligible pool...");
        const rankedJobs = intelligentJobRanker.rankAndSortJobs(rawDiscoveredJobs, candidateProfile);
        telemetry.Ranked = rankedJobs.length;
        telemetry.FinalCandidates = rankedJobs.length;

        console.log("\n==================================================");
        console.log("NAUKRI RANKING SUMMARY");
        console.log(`Discovery Status:         ${telemetry.discoveryStatus}`);
        console.log(`Discovered:               ${telemetry.Discovered}`);
        console.log(`Role Eligible:            ${telemetry.RoleEligible}`);
        console.log(`Experience Eligible:      ${telemetry.ExperienceEligible}`);
        console.log(`Location Eligible:        ${telemetry.LocationEligible}`);
        console.log(`Duplicates Removed:       ${telemetry.Duplicates}`);
        console.log(`Already Applied Excluded: ${telemetry.AlreadyApplied}`);
        console.log(`Ranked Candidates:        ${telemetry.Ranked}`);
        console.log(`Daily Remaining Capacity: ${telemetry.dailyRemainingCapacity}`);
        console.log("==================================================\n");

        console.log("TOP RANKED CANDIDATE JOBS:");
        console.log("--------------------------------------------------");
        rankedJobs.slice(0, 20).forEach((j, idx) => {
            console.log(`[Rank ${idx + 1}] Score: ${j.rankScore}/100 | ${j.title}`);
            console.log(`         Company:     ${j.company}`);
            console.log(`         Exp:         ${j.experience}`);
            console.log(`         Location:    ${j.location}`);
            console.log(`         Explanation: ${j.selectionReason}`);
            console.log(`         URL:         ${j.url}\n`);
        });

        if (isDryRun) {
            saveTelemetry();
            process.exit(0);
        }

        // PHASE 4-7 — LIVE APPLICATION WORKFLOW WITH FAILURE ISOLATION
        logger.info("\n[4/4] Processing Live Applications with Quality Gate & Verification...");
        let applicationsRun = 0;
        const appPage = await context.newPage();

        for (const target of rankedJobs) {
            if (applicationsRun >= MAX_APPLICATIONS_PER_RUN) break;
            if ((appliedToday + applicationsRun) >= MAX_APPLICATIONS_PER_DAY) break;

            // ISOLATED FAILURE BOUNDARY (Phase 11)
            try {
                // 10-Point Application Quality Gate Revalidation (Phase 4)
                if (!target.jobId || !target.url) {
                    logger.warn("   [Quality Gate] Invalid job model/url. Skipping.");
                    telemetry.SkippedQualityGate++;
                    continue;
                }

                const preCheck = await db.get("SELECT id, applied, status FROM jobs WHERE LOWER(portal) = 'naukri' AND (job_id = ? OR url = ?)", [target.jobId, target.url]);
                if (preCheck && (preCheck.applied === 1 || ["APPLIED", "EMPLOYER_PENDING", "APPLICATION_SUBMITTED", "INTERVIEW_REQUESTED"].includes(preCheck.status))) {
                    logger.info(`   [Quality Gate] Job ${target.jobId} already applied in DB. Skipping.`);
                    telemetry.AlreadyApplied++;
                    continue;
                }

                const expCheck = checkExperienceEligibility(target.experience);
                if (!expCheck.eligible) {
                    logger.warn(`   [Quality Gate] Experience revalidation failed for ${target.jobId}. Skipping.`);
                    telemetry.SkippedQualityGate++;
                    continue;
                }

                const locCheck = checkLocationEligibility(target.location, target.title);
                if (!locCheck.eligible) {
                    logger.warn(`   [Quality Gate] Location revalidation failed for ${target.jobId}. Skipping.`);
                    telemetry.SkippedQualityGate++;
                    continue;
                }

                telemetry.Attempted++;
                logger.info(`\n[Application ${applicationsRun + 1}/${MAX_APPLICATIONS_PER_RUN}] Attempting Rank #${rankedJobs.indexOf(target) + 1} (Score: ${target.rankScore}/100): "${target.title}" at "${target.company}"`);

                let appNavRes = null;
                try {
                    appNavRes = await appPage.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                    await delay(3000);
                } catch (navErr) {
                    logger.warn(`   [Quality Gate] Application page navigation failed for ${target.jobId}: ${navErr.message}`);
                    telemetry.Failed++;
                    continue;
                }

                // Re-verify UI Applied state
                const alreadyAppliedLoc = appPage.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied'), div:has-text('Applied')");
                if (await alreadyAppliedLoc.count().catch(() => 0) > 0) {
                    logger.info(`   [Quality Gate] Already applied on Naukri portal for job ${target.jobId}. Updating DB.`);
                    await db.run("INSERT OR REPLACE INTO jobs (portal, job_id, company, title, location, experience, url, status, applied, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'EMPLOYER_PENDING', 1, CURRENT_TIMESTAMP)", [target.jobId, target.company, target.title, target.location, target.experience, target.url]);
                    telemetry.AlreadyApplied++;
                    continue;
                }

                // Check Apply button
                const applyBtnLoc = appPage.locator("button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')").first();
                const applyBtnText = (await applyBtnLoc.count().catch(() => 0) > 0) ? (await applyBtnLoc.textContent().catch(() => "")) : "";
                const isExternal = applyBtnText.toLowerCase().includes("company site") || applyBtnText.toLowerCase().includes("company website");

                if (isExternal) {
                    logger.info(`   External application required for ${target.jobId}. Marking EXTERNAL_APPLICATION_REQUIRED.`);
                    await db.run("INSERT OR REPLACE INTO jobs (portal, job_id, company, title, location, experience, url, status, applied, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'EXTERNAL_APPLICATION_REQUIRED', 0, CURRENT_TIMESTAMP)", [target.jobId, target.company, target.title, target.location, target.experience, target.url]);
                    telemetry.ExternalRequired++;
                    continue;
                }

                if (!(await applyBtnLoc.count().catch(() => 0) > 0)) {
                    logger.warn(`   Apply button not found on UI for ${target.jobId}. Skipping.`);
                    telemetry.Failed++;
                    continue;
                }

                // Record DB & emit APPLICATION_STARTED
                await db.run("INSERT OR REPLACE INTO jobs (portal, job_id, company, title, location, experience, url, status, applied, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'APPLICATION_STARTED', 0, CURRENT_TIMESTAMP)", [target.jobId, target.company, target.title, target.location, target.experience, target.url]);

                eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
                    portal: "Naukri",
                    jobId: target.jobId,
                    company: target.company,
                    title: target.title,
                    url: target.url
                });

                // Attach Resume
                const fileInputLoc = appPage.locator("input[type='file']").first();
                if (await fileInputLoc.count().catch(() => 0) > 0) {
                    try {
                        const resumePath = await resumeManager.getResumePath("naukri");
                        await fileInputLoc.setInputFiles(resumePath).catch(() => {});
                    } catch (e) {}
                }

                // Click Apply
                logger.info("   Clicking Apply Button on Naukri UI...");
                await applyBtnLoc.click();
                await delay(4000);

                // Check questionnaire
                const questLoc = appPage.locator(".chatbot-container, .questionnaire-container, :has-text('Answer questions')");
                if (await questLoc.count().catch(() => 0) > 0) {
                    logger.warn(`   Questionnaire pop-up detected for job ${target.jobId}. Setting WAITING_FOR_INPUT.`);
                    eventBus.publish(eventBus.EVENTS.WAITING_FOR_INPUT, {
                        portal: "Naukri",
                        jobId: target.jobId,
                        company: target.company,
                        title: target.title,
                        question: "Naukri pop-up questionnaire requires candidate input.",
                        url: target.url
                    });
                    await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT' WHERE LOWER(portal) = 'naukri' AND job_id = ?", [target.jobId]);
                    telemetry.WaitingForInput++;
                    continue;
                }

                // Independent fresh context post-apply verification (Phase 5)
                const fresh = await chromium.launch({
                    headless: true,
                    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
                });
                const freshCtx = await fresh.newContext({
                    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    viewport: { width: 1440, height: 900 },
                    storageState: storageStatePath
                });
                const freshPage = await freshCtx.newPage();
                await freshPage.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
                await delay(3000);

                const isVerified = await freshPage.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied')").count().catch(() => 0) > 0;
                await freshCtx.close().catch(() => {});
                await fresh.close().catch(() => {});

                if (isVerified) {
                    await db.run("UPDATE jobs SET status = 'EMPLOYER_PENDING', applied = 1, updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [target.jobId]);

                    eventBus.publish(eventBus.EVENTS.APPLICATION_SUBMITTED, {
                        portal: "Naukri",
                        jobId: target.jobId,
                        company: target.company,
                        title: target.title,
                        status: "EMPLOYER_PENDING",
                        url: target.url
                    });

                    applicationsRun++;
                    telemetry.Applied++;
                    logger.info(`✓ Verified Application Submitted for "${target.title}" at "${target.company}".`);
                } else {
                    logger.warn(`⚠️ Submission unverified for job ${target.jobId}. Setting CLICKED_UNVERIFIED.`);
                    await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED' WHERE LOWER(portal) = 'naukri' AND job_id = ?", [target.jobId]);
                    telemetry.Failed++;
                }

                if (applicationsRun < MAX_APPLICATIONS_PER_RUN) {
                    const delayMs = Math.floor(Math.random() * 15000) + 10000;
                    logger.info(` -> Delaying ${Math.round(delayMs / 1000)}s before next application...`);
                    await delay(delayMs);
                }

            } catch (jobErr) {
                // ISOLATED FAILURE BOUNDARY — Continue processing next ranked job
                logger.error(`❌ Non-fatal application error for job ${target.jobId}: ${jobErr.message}`);
                telemetry.Failed++;
            }
        }

        await appPage.close().catch(() => {});

        saveTelemetry();

        // PHASE 10 — TELEGRAM PRODUCTION OBSERVABILITY (RUN COMPLETE SUMMARY)
        const telegramService = require("../apps/telegram");
        await telegramService.sendMessage(
            `<b>📊 NAUKRI RUN COMPLETE</b>\n\n` +
            `• <b>Discovery Status</b>: <code>${telemetry.discoveryStatus}</code>\n` +
            `• <b>Discovered</b>: ${telemetry.Discovered}\n` +
            `• <b>Eligible</b>: ${telemetry.ExperienceEligible}\n` +
            `• <b>Ranked</b>: ${telemetry.Ranked}\n` +
            `• <b>Attempted</b>: ${telemetry.Attempted}\n` +
            `• <b>Applied</b>: ${telemetry.Applied}\n` +
            `• <b>Waiting For Input</b>: ${telemetry.WaitingForInput}\n` +
            `• <b>External Required</b>: ${telemetry.ExternalRequired}\n` +
            `• <b>Failed</b>: ${telemetry.Failed}\n` +
            `• <b>Skipped / Duplicates</b>: ${telemetry.Duplicates + telemetry.AlreadyApplied}\n` +
            `• <b>Daily Applied Count</b>: ${appliedToday + telemetry.Applied} / ${MAX_APPLICATIONS_PER_DAY}\n` +
            `• <b>Daily Remaining</b>: ${Math.max(0, MAX_APPLICATIONS_PER_DAY - (appliedToday + telemetry.Applied))}`
        ).catch(err => logger.error(`Failed to send Telegram run summary: ${err.message}`));

    } catch (err) {
        logger.error(`❌ Global Production Runner Error: ${err.message}`);
        telemetry.zeroApplicationReason = "RUNNER_ERROR";
        saveTelemetry();
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
