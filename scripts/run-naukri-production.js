const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").naukri;
const eventBus = require("../packages/events/EventBus");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const resumeManager = require("../packages/resume/ResumeManager");

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

    const telemetry = {
        timestamp: new Date().toISOString(),
        isDryRun,
        Discovered: 0,
        RoleEligible: 0,
        ExperienceEligible: 0,
        LocationEligible: 0,
        Duplicates: 0,
        AlreadyApplied: 0,
        FinalCandidates: 0,
        Attempted: 0,
        Applied: 0,
        WaitingForInput: 0,
        ExternalRequired: 0,
        Failed: 0,
        zeroApplicationReason: null,
        dailyLimit: MAX_APPLICATIONS_PER_DAY,
        dailyAppliedCount: 0
    };

    const saveTelemetry = () => {
        try {
            const sessionPath = path.join(process.cwd(), "sessions", "naukri");
            fs.mkdirpSync(sessionPath);
            fs.writeJsonSync(path.join(sessionPath, "last_run_telemetry.json"), telemetry, { spaces: 2 });
        } catch (e) {}
    };

    // Calculate daily successful applications count from SQLite
    const todayStr = new Date().toISOString().split("T")[0];
    const appliedTodayRow = await db.get(
        "SELECT COUNT(*) as count FROM jobs WHERE portal = 'naukri' AND applied = 1 AND DATE(updated_at) = ?",
        [todayStr]
    );
    const appliedToday = appliedTodayRow ? appliedTodayRow.count : 0;
    telemetry.dailyAppliedCount = appliedToday;

    logger.info(`Daily Naukri Applications Counter: ${appliedToday} / ${MAX_APPLICATIONS_PER_DAY}`);

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
            "The saved Naukri session has expired or is missing.\n" +
            "Manual session refresh is required via <code>node scripts/setup-naukri-session.js</code>."
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

        const page = await context.newPage();

        // 1. Session Health Check
        logger.info("[1/4] Verifying Authenticated Naukri Session...");
        await page.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        const isLoginRedirect = currentUrl.includes("/nlogin/") || currentUrl.includes("/login");
        if (isLoginRedirect) {
            logger.error("❌ Naukri session redirect detected. Re-authentication required.");
            const telegramService = require("../apps/telegram");
            await telegramService.sendMessage(
                "<b>⚠️ Naukri Authentication Required</b>\n\n" +
                "The saved Naukri session has expired on Oracle VM.\n" +
                "Manual session refresh is required."
            ).catch(() => {});

            telemetry.zeroApplicationReason = "AUTH_EXPIRED";
            saveTelemetry();
            process.exit(0);
        }
        logger.info("✓ Authenticated Naukri Session Verified.");

        // 2. Discover Relevant Candidate Jobs
        logger.info("\n[2/4] Executing Fresh Job Discovery across target searches...");
        const discoveredJobs = [];
        const seenIds = new Set();

        for (const searchUrl of TARGET_SEARCH_URLS) {
            logger.info(`Searching: ${searchUrl}`);
            await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(3500);

            const jobSelector = "article.jobTuple, div.srp-jobtuple, article.srp-jobtuple, [data-job-id], .cust-job-tuple";
            const cards = page.locator(jobSelector);
            const count = await cards.count().catch(() => 0);
            logger.info(`Found ${count} job cards on ${searchUrl}`);

            for (let i = 0; i < count; i++) {
                try {
                    const item = cards.nth(i);
                    const titleLoc = item.locator("a.title, .title, [class*='title']").first();
                    const title = (await titleLoc.textContent().catch(() => "")).trim();
                    const url = await titleLoc.getAttribute("href").catch(() => "");
                    if (!title || !url) continue;

                    const companyLoc = item.locator(".companyName, .company, a.comp-name, [class*='company']").first();
                    const company = (await companyLoc.textContent().catch(() => "Naukri Employer")).trim();

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
                    const titleLower = title.toLowerCase();
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

                    const locCheck = checkLocationEligibility(location, title);
                    if (!locCheck.eligible) continue;
                    telemetry.LocationEligible++;

                    // Database Duplicates Check
                    const dbRecord = await db.get("SELECT * FROM jobs WHERE portal = 'naukri' AND (job_id = ? OR url = ?)", [jobId, url]);
                    if (dbRecord) {
                        telemetry.Duplicates++;
                        if (dbRecord.applied === 1 || ["APPLIED", "EMPLOYER_PENDING", "APPLICATION_SUBMITTED", "INTERVIEW_REQUESTED"].includes(dbRecord.status)) {
                            telemetry.AlreadyApplied++;
                            continue;
                        }
                    }

                    discoveredJobs.push({
                        jobId,
                        title,
                        company,
                        location,
                        experience,
                        url,
                        expReason: expCheck.reason
                    });

                } catch (cardErr) {}
            }
            await page.waitForTimeout(2000);
        }

        telemetry.FinalCandidates = discoveredJobs.length;
        logger.info(`✓ Discovered ${discoveredJobs.length} eligible unapplied Naukri candidates.`);

        if (isDryRun) {
            console.log("\n==================================================");
            console.log("NAUKRI DRY-RUN REPORT");
            console.log(`Discovered:          ${telemetry.Discovered}`);
            console.log(`Role Eligible:       ${telemetry.RoleEligible}`);
            console.log(`Experience Eligible: ${telemetry.ExperienceEligible}`);
            console.log(`Location Eligible:   ${telemetry.LocationEligible}`);
            console.log(`Duplicates:          ${telemetry.Duplicates}`);
            console.log(`Already Applied:     ${telemetry.AlreadyApplied}`);
            console.log(`Final Candidates:    ${telemetry.FinalCandidates}`);
            console.log("==================================================\n");

            console.log("TOP ELIGIBLE CANDIDATE JOBS (WOULD APPLY):");
            console.log("--------------------------------------------------");
            discoveredJobs.slice(0, 10).forEach((j, idx) => {
                console.log(`[${idx + 1}] ${j.title}`);
                console.log(`    Company:  ${j.company}`);
                console.log(`    Exp:      ${j.experience}`);
                console.log(`    Location: ${j.location}`);
                console.log(`    Eligible: ${j.expReason}`);
                console.log(`    URL:      ${j.url}\n`);
            });

            saveTelemetry();
            process.exit(0);
        }

        // 3. Process Live Applications
        let applicationsRun = 0;
        for (const target of discoveredJobs) {
            if (applicationsRun >= MAX_APPLICATIONS_PER_RUN) break;
            if ((appliedToday + applicationsRun) >= MAX_APPLICATIONS_PER_DAY) break;

            telemetry.Attempted++;
            logger.info(`\n[Application ${applicationsRun + 1}/${MAX_APPLICATIONS_PER_RUN}] Processing: "${target.title}" at "${target.company}" (${target.experience})`);

            // Re-verify duplicate immediately prior to opening
            const preCheck = await db.get("SELECT id FROM jobs WHERE portal = 'naukri' AND job_id = ? AND applied = 1", [target.jobId]);
            if (preCheck) {
                logger.info(`   Skipping duplicate ${target.jobId} (already applied in DB).`);
                continue;
            }

            await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(3000);

            // Check if already applied on portal
            const alreadyAppliedLoc = page.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied'), div:has-text('Applied')");
            if (await alreadyAppliedLoc.count().catch(() => 0) > 0) {
                logger.info(`   Already applied on Naukri portal for job ${target.jobId}. Updating DB.`);
                await db.run("INSERT OR REPLACE INTO jobs (portal, job_id, company, title, location, experience, url, status, applied, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'EMPLOYER_PENDING', 1, CURRENT_TIMESTAMP)", [target.jobId, target.company, target.title, target.location, target.experience, target.url]);
                telemetry.AlreadyApplied++;
                continue;
            }

            // Check apply button
            const applyBtnLoc = page.locator("button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')").first();
            const applyBtnText = (await applyBtnLoc.count().catch(() => 0) > 0) ? (await applyBtnLoc.textContent().catch(() => "")) : "";
            const isExternal = applyBtnText.toLowerCase().includes("company site") || applyBtnText.toLowerCase().includes("company website");

            if (isExternal) {
                logger.info(`   External application required for ${target.jobId}. Marking EXTERNAL_APPLICATION_REQUIRED.`);
                await db.run("INSERT OR REPLACE INTO jobs (portal, job_id, company, title, location, experience, url, status, applied, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'EXTERNAL_APPLICATION_REQUIRED', 0, CURRENT_TIMESTAMP)", [target.jobId, target.company, target.title, target.location, target.experience, target.url]);
                telemetry.ExternalRequired++;
                continue;
            }

            if (!(await applyBtnLoc.count().catch(() => 0) > 0)) {
                logger.warn(`   Apply button not found for ${target.jobId}. Skipping.`);
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

            // Check file input for resume attachment
            const fileInputLoc = page.locator("input[type='file']").first();
            if (await fileInputLoc.count().catch(() => 0) > 0) {
                try {
                    const resumePath = await resumeManager.getResumePath("naukri");
                    await fileInputLoc.setInputFiles(resumePath).catch(() => {});
                } catch (e) {}
            }

            // Click Apply
            logger.info("   Clicking Apply Button on Naukri UI...");
            await applyBtnLoc.click();
            await page.waitForTimeout(4000);

            // Check questionnaire
            const questLoc = page.locator(".chatbot-container, .questionnaire-container, :has-text('Answer questions')");
            if (await questLoc.count().catch(() => 0) > 0) {
                logger.warn(`   Questionnaire pop-up detected for job ${target.jobId}.`);
                eventBus.publish(eventBus.EVENTS.WAITING_FOR_INPUT, {
                    portal: "Naukri",
                    jobId: target.jobId,
                    company: target.company,
                    title: target.title,
                    question: "Naukri pop-up questionnaire requires candidate input.",
                    url: target.url
                });
                await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT' WHERE portal = 'naukri' AND job_id = ?", [target.jobId]);
                telemetry.WaitingForInput++;
                continue;
            }

            // Fresh context post-apply verification
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
            await freshPage.waitForTimeout(3000);

            const isVerified = await freshPage.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied')").count().catch(() => 0) > 0;
            await freshCtx.close().catch(() => {});
            await fresh.close().catch(() => {});

            if (isVerified) {
                await db.run("UPDATE jobs SET status = 'EMPLOYER_PENDING', applied = 1, updated_at = CURRENT_TIMESTAMP WHERE portal = 'naukri' AND job_id = ?", [target.jobId]);

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
                await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED' WHERE portal = 'naukri' AND job_id = ?", [target.jobId]);
                telemetry.Failed++;
            }

            if (applicationsRun < MAX_APPLICATIONS_PER_RUN) {
                const delayMs = Math.floor(Math.random() * 15000) + 10000;
                logger.info(` -> Delaying ${Math.round(delayMs / 1000)}s before next application...`);
                await page.waitForTimeout(delayMs);
            }
        }

        saveTelemetry();

        // Send Telegram Run Summary
        const telegramService = require("../apps/telegram");
        await telegramService.sendRunSummaryNotification({
            portal: "Naukri",
            discovered: telemetry.Discovered,
            eligible: telemetry.FinalCandidates,
            attempted: telemetry.Attempted,
            applied: telemetry.Applied,
            waitingForInput: telemetry.WaitingForInput,
            failed: telemetry.Failed,
            skippedDuplicates: telemetry.Duplicates + telemetry.AlreadyApplied
        }).catch(err => logger.error(`Failed to send Telegram run summary: ${err.message}`));

    } catch (err) {
        logger.error(`❌ Production Runner Error: ${err.message}`);
        telemetry.zeroApplicationReason = "RUNNER_ERROR";
        saveTelemetry();
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
