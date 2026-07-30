const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const eventBus = require("../packages/events/EventBus");
const telegramService = require("../apps/telegram");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const resumeManager = require("../packages/resume/ResumeManager");

const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const NaukriConcurrencyLock = require("../packages/plugins/naukri/NaukriConcurrencyLock");
const NaukriDiagnostics = require("../packages/plugins/naukri/NaukriDiagnostics");

const { pullDatabase, pushDatabase } = require("./sync-naukri-database");

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
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    logger.info("==================================================");
    logger.info("NAUKRI HARDENED PRODUCTION AUTOMATION RUNNER");
    logger.info(`Execution Host: ${executionHost}`);
    logger.info(`Mode: ${isDryRun ? "DRY RUN (No Applications Submitted)" : "ACTIVE PRODUCTION (Live Submissions)"}`);
    logger.info(`Execution Time: ${new Date().toISOString()}`);
    logger.info(`Limits: Max ${MAX_APPLICATIONS_PER_RUN} per run, Max ${MAX_APPLICATIONS_PER_DAY} per day`);
    logger.info("==================================================\n");

    const lock = new NaukriConcurrencyLock("naukri_job_automation.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ naukri_job_automation runner is already executing. Exiting as SKIPPED_ALREADY_RUNNING.");
        process.exit(0);
    }

    if (process.platform === "win32") {
        await pullDatabase().catch(() => {});
    }

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
        lock.release();
        process.exit(0);
    }

    // 1. Session Bootstrap & Health Verification
    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status === "SESSION_EXPIRED") {
        logger.error("❌ Automation halted: Naukri session expired. Re-authentication required.");
        telemetry.zeroApplicationReason = "AUTH_EXPIRED";
        saveTelemetry();
        lock.release();
        process.exit(0);
    }

    if (boot.status === "AKAMAI_BLOCKED") {
        logger.error("❌ Automation halted: Akamai 403 Access Denied during bootstrap.");
        await NaukriDiagnostics.persist(boot.page, null, "BOOTSTRAP_AKAMAI_BLOCKED", "AKAMAI_TEMPORARY_BLOCK");
        if (boot.browser) await boot.browser.close().catch(() => {});
        telemetry.zeroApplicationReason = "AKAMAI_TEMPORARY_BLOCK";
        saveTelemetry();

        await telegramService.sendMessage(
            "<b>⚠️ Naukri Akamai Block Detected</b>\n\n" +
            "• <b>Portal</b>: <code>Naukri</code>\n" +
            "• <b>Status</b>: <code>AKAMAI_TEMPORARY_BLOCK</code>\n" +
            "• <b>Action</b>: Halted execution safely. Deferring run to next scheduled cycle."
        ).catch(() => {});

        lock.release();
        process.exit(0);
    }

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        logger.error(`❌ Automation halted: Bootstrap failed with status ${boot.status}`);
        if (boot.browser) await boot.browser.close().catch(() => {});
        telemetry.zeroApplicationReason = "BOOTSTRAP_FAILED";
        saveTelemetry();
        lock.release();
        process.exit(0);
    }

    const { browser, context, page: discoveryPage } = boot;

    try {
        // 2. Job Discovery Across Target Searches with Natural Request Pacing
        logger.info("\n[2/4] Executing Job Discovery across target searches with natural pacing...");
        const rawDiscoveredJobs = [];
        const seenIds = new Set();
        let blockedSearchCount = 0;
        let successfulSearchCount = 0;

        for (let sIdx = 0; sIdx < TARGET_SEARCH_URLS.length; sIdx++) {
            const searchUrl = TARGET_SEARCH_URLS[sIdx];
            logger.info(`Searching (${sIdx + 1}/${TARGET_SEARCH_URLS.length}): ${searchUrl}`);

            if (sIdx > 0) {
                const searchDelay = Math.floor(Math.random() * 3000) + 5000; // 5-8s natural delay
                await delay(searchDelay);
            }

            let res = null;
            let navSuccess = false;
            try {
                res = await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await delay(3000);
                navSuccess = true;
            } catch (navErr) {
                logger.warn(`Navigation warning on ${searchUrl}: ${navErr.message}`);
            }

            let title = await discoveryPage.title().catch(() => "");
            let status = res ? res.status() : 0;
            let isAccessDenied = !navSuccess || status === 403 || title.toLowerCase().includes("access denied");

            if (isAccessDenied) {
                logger.warn(`⚠️ Akamai 403 detected on ${searchUrl}. Halting further search navigations cleanly...`);
                await NaukriDiagnostics.persist(discoveryPage, res, `SEARCH_${sIdx}_AKAMAI`, "AKAMAI_TEMPORARY_BLOCK");
                blockedSearchCount++;
                break;
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

                    const expLoc = item.locator(".exp, .experience, [class*='exp']").first();
                    const expText = (await expLoc.count().catch(() => 0) > 0)
                        ? (await expLoc.textContent().catch(() => "")).trim()
                        : "";

                    const locLoc = item.locator(".loc, .location, [class*='loc']").first();
                    const locText = (await locLoc.count().catch(() => 0) > 0)
                        ? (await locLoc.textContent().catch(() => "")).trim()
                        : "Bangalore";

                    rawDiscoveredJobs.push({
                        id: jobId,
                        job_id: jobId,
                        title: titleText,
                        role: titleText,
                        company,
                        url,
                        apply_link: url,
                        experience: expText,
                        location: locText,
                        portal: "naukri"
                    });
                } catch (cardErr) {}
            }
        }

        if (blockedSearchCount > 0) {
            logger.warn("⚠️ Akamai rate-limit encountered during discovery. Halting application phase safely.");
            telemetry.zeroApplicationReason = "AKAMAI_TEMPORARY_BLOCK";
            saveTelemetry();

            await telegramService.sendMessage(
                "<b>⚠️ Naukri Akamai Block Detected</b>\n\n" +
                "• <b>Portal</b>: <code>Naukri</code>\n" +
                "• <b>Status</b>: <code>AKAMAI_TEMPORARY_BLOCK</code>\n" +
                "• <b>Searches Completed</b>: <code>" + successfulSearchCount + " / " + TARGET_SEARCH_URLS.length + "</code>\n" +
                "• <b>Action</b>: Discovery halted cleanly to avoid IP escalation."
            ).catch(() => {});

            lock.release();
            process.exit(0);
        }

        // Anomaly Detection: All searches executed without Akamai block but yielded ZERO cards
        if (successfulSearchCount === TARGET_SEARCH_URLS.length && rawDiscoveredJobs.length === 0) {
            logger.error("❌ DISCOVERY ANOMALY: All 6 target searches succeeded without Akamai blocks but returned 0 job cards!");
            await NaukriDiagnostics.persist(discoveryPage, null, "DISCOVERY_ANOMALY", "DISCOVERY_ANOMALY");
            telemetry.discoveryStatus = "DISCOVERY_ANOMALY";
            telemetry.zeroApplicationReason = "DISCOVERY_ANOMALY";
            saveTelemetry();

            await telegramService.sendMessage(
                "<b>⚠️ Naukri Discovery Anomaly Detected</b>\n\n" +
                "• <b>Portal</b>: <code>Naukri</code>\n" +
                "• <b>Status</b>: <code>DISCOVERY_ANOMALY</code>\n" +
                "• <b>Details</b>: 6 target searches completed cleanly but 0 job cards were discovered.\n" +
                "• <b>Action</b>: Applications skipped. Inspect page layout or selector definitions."
            ).catch(() => {});

            lock.release();
            process.exit(0);
        }

        logger.info(`✓ Discovery Phase Complete. Total Raw Jobs Discovered: ${rawDiscoveredJobs.length}`);

        // 3. Eligibility Filtering & Intelligent Ranking
        logger.info("\n[3/4] Filtering & Ranking Eligible Jobs...");
        const eligibleJobs = [];
        let expEligibleCount = 0;
        let expIneligibleCount = 0;
        let locEligibleCount = 0;
        let duplicatesCount = 0;
        let alreadyAppliedCount = 0;

        telemetry.RawDiscovered = rawDiscoveredJobs.length;
        telemetry.UniqueJobs = seenIds.size;
        telemetry.RoleEligible = rawDiscoveredJobs.length;

        for (const job of rawDiscoveredJobs) {
            // Check experience overlap (1-6 YOE policy: jobMin <= 6 AND jobMax >= 1)
            const expResult = checkExperienceEligibility(job.experience, candidateProfile.minYearsExperience || 1, candidateProfile.maxYearsExperience || 6);
            if (!expResult.eligible) {
                expIneligibleCount++;
                logger.info(`[Exp Filter] REJECTED: Job ID ${job.id} | Title: "${job.title}" | Exp: "${job.experience}" | Reason: ${expResult.reason}`);
                continue;
            }
            expEligibleCount++;

            const locResult = checkLocationEligibility(job.location, candidateProfile.preferredLocations || ["Bangalore", "Bengaluru", "Remote", "Hybrid"]);
            if (!locResult.eligible) {
                logger.info(`[Loc Filter] REJECTED: Job ID ${job.id} | Title: "${job.title}" | Loc: "${job.location}" | Reason: ${locResult.reason}`);
                continue;
            }
            locEligibleCount++;

            // Duplicate Check in SQLite DB
            const existingJob = await db.get("SELECT id, job_id, applied FROM jobs WHERE LOWER(portal) = 'naukri' AND (job_id = ? OR url = ?)", [job.id, job.url]);
            if (existingJob) {
                if (existingJob.applied) {
                    alreadyAppliedCount++;
                    continue;
                }
                duplicatesCount++;
            }

            // Save new job record into DB
            if (!existingJob) {
                await db.run(
                    "INSERT INTO jobs (portal, job_id, title, company, location, url, experience, status, timestamp) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'DISCOVERED', CURRENT_TIMESTAMP)",
                    [job.id, job.title, job.company, job.location, job.url, job.experience]
                );
            }

            eligibleJobs.push(job);
        }

        telemetry.ExperienceEligible = expEligibleCount;
        telemetry.ExperienceIneligible = expIneligibleCount;
        telemetry.LocationEligible = locEligibleCount;
        telemetry.Duplicates = duplicatesCount;
        telemetry.AlreadyApplied = alreadyAppliedCount;
        telemetry.FinalEligible = eligibleJobs.length;

        logger.info(`\n==================================================`);
        logger.info(`NAUKRI FILTERING & SELECTION TELEMETRY REPORT`);
        logger.info(`==================================================`);
        logger.info(`Raw Discovered:                  ${telemetry.RawDiscovered}`);
        logger.info(`Unique Jobs:                     ${telemetry.UniqueJobs}`);
        logger.info(`Role Eligible:                   ${telemetry.RoleEligible}`);
        logger.info(`Experience Eligible (1-6 Overlap): ${telemetry.ExperienceEligible}`);
        logger.info(`Experience Ineligible (>6 YOE):  ${telemetry.ExperienceIneligible}`);
        logger.info(`Location Eligible:               ${telemetry.LocationEligible}`);
        logger.info(`Duplicates Removed:              ${telemetry.Duplicates}`);
        logger.info(`Already Applied Removed:         ${telemetry.AlreadyApplied}`);
        logger.info(`Final Eligible Pool:             ${telemetry.FinalEligible}`);
        logger.info(`==================================================\n`);

        if (eligibleJobs.length === 0) {
            logger.info("No new eligible jobs found for application in this run.");
            telemetry.zeroApplicationReason = "NO_ELIGIBLE_JOBS";
            saveTelemetry();
            lock.release();
            process.exit(0);
        }

        // Rank Eligible Jobs using Intelligent Job Ranker
        const rankedJobs = intelligentJobRanker.rankJobs(eligibleJobs, candidateProfile);
        telemetry.Ranked = rankedJobs.length;

        const runLimit = Math.min(MAX_APPLICATIONS_PER_RUN, telemetry.dailyRemainingCapacity);
        const finalCandidates = rankedJobs.slice(0, runLimit);
        telemetry.FinalCandidates = finalCandidates.length;

        logger.info(`Targeting Top ${finalCandidates.length} Ranked Candidates for Application.`);

        if (isDryRun) {
            logger.info("\n==================================================");
            logger.info("TOP CANDIDATES SELECTED FOR APPLICATION (DRY RUN)");
            logger.info("==================================================");
            for (let i = 0; i < finalCandidates.length; i++) {
                const j = finalCandidates[i];
                const expCheck = checkExperienceEligibility(j.experience, 1, 6);
                logger.info(`[Dry-Run Job #${i + 1}] ID: ${j.id}`);
                logger.info(`  Title:              ${j.title}`);
                logger.info(`  Company:            ${j.company}`);
                logger.info(`  Experience:         ${j.experience}`);
                logger.info(`  Location:           ${j.location}`);
                logger.info(`  Match Score:        ${j.matchScore || "N/A"}`);
                logger.info(`  1-6 YOE Overlap:    ${expCheck.eligible ? "ELIGIBLE" : "INELIGIBLE"}`);
                logger.info(`  Previously Applied: NO`);
                logger.info(`--------------------------------------------------`);
            }
            telemetry.zeroApplicationReason = "DRY_RUN_ONLY";
            saveTelemetry();
            lock.release();
            process.exit(0);
        }

        // 4. Live Job Application Execution with Independent Verification
        logger.info("\n[4/4] Executing Controlled Live Job Applications...");
        await discoveryPage.close().catch(() => {}); // Close discovery page safely

        for (let aIdx = 0; aIdx < finalCandidates.length; aIdx++) {
            const targetJob = finalCandidates[aIdx];
            logger.info(`\n--- Application (${aIdx + 1}/${finalCandidates.length}) for Job ID: ${targetJob.id} ---`);
            logger.info(`Title:      ${targetJob.title}`);
            logger.info(`Company:    ${targetJob.company}`);
            logger.info(`URL:        ${targetJob.url}`);
            logger.info(`Experience: ${targetJob.experience}`);

            telemetry.Attempted++;
            await db.run("UPDATE jobs SET status = 'APPLICATION_STARTED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [targetJob.id]);
            eventBus.publish("APPLICATION_STARTED", { portal: "Naukri", jobId: targetJob.id, title: targetJob.title, company: targetJob.company });

            const jobPage = await context.newPage();
            let appRes = null;
            try {
                appRes = await jobPage.goto(targetJob.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                await delay(3000);
            } catch (jobNavErr) {
                logger.warn(`Failed navigating to job page ${targetJob.url}: ${jobNavErr.message}`);
                telemetry.Failed++;
                await jobPage.close().catch(() => {});
                continue;
            }

            let pageTitle = await jobPage.title().catch(() => "");
            let status = appRes ? appRes.status() : 0;
            if (status === 403 || pageTitle.toLowerCase().includes("access denied")) {
                logger.warn("⚠️ Akamai 403 encountered on job page. Stopping further application submissions.");
                await NaukriDiagnostics.persist(jobPage, appRes, `JOB_${targetJob.id}_AKAMAI`, "AKAMAI_TEMPORARY_BLOCK");
                await jobPage.close().catch(() => {});
                telemetry.Failed++;
                break;
            }

            // Locate Apply Button
            const applyBtnLocators = [
                jobPage.locator("button:has-text('Apply')"),
                jobPage.locator("button.apply-button"),
                jobPage.locator("#apply-button"),
                jobPage.locator("button:has-text('Apply on company site')")
            ];

            let applyBtn = null;
            for (const loc of applyBtnLocators) {
                if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                    applyBtn = loc.first();
                    break;
                }
            }

            if (!applyBtn) {
                logger.warn(`Apply button not visible for job ID ${targetJob.id}. Checking if already applied...`);
                const pageText = await jobPage.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
                if (pageText.toLowerCase().includes("applied") || pageText.toLowerCase().includes("already applied")) {
                    logger.info(`✓ Job ID ${targetJob.id} already applied on portal.`);
                    await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [targetJob.id]);
                    telemetry.Applied++;
                } else {
                    telemetry.Failed++;
                }
                await jobPage.close().catch(() => {});
                continue;
            }

            const btnText = (await applyBtn.textContent().catch(() => "")).trim();
            if (btnText.toLowerCase().includes("company site")) {
                logger.info(`Job ID ${targetJob.id} requires external company site application. Skipping.`);
                await db.run("UPDATE jobs SET status = 'EXTERNAL_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [targetJob.id]);
                telemetry.ExternalRequired++;
                await jobPage.close().catch(() => {});
                continue;
            }

            // Perform Apply Click
            logger.info(`Clicking Apply button for ${targetJob.title}...`);
            await applyBtn.click().catch(() => {});
            await delay(4000);

            // Check for Questionnaire Modal
            const modalText = await jobPage.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
            const hasQuestionnaire = modalText.toLowerCase().includes("questionnaire") || modalText.toLowerCase().includes("answer questions") || jobPage.url().includes("questionnaire");

            if (hasQuestionnaire) {
                logger.info(`Job ID ${targetJob.id} opened a questionnaire modal. Flagging as WAITING_FOR_INPUT.`);
                await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [targetJob.id]);
                telemetry.WaitingForInput++;
                await jobPage.close().catch(() => {});
                continue;
            }

            // Independent Portal Verification
            await delay(2000);
            const postApplyText = await jobPage.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
            const isConfirmedApplied = postApplyText.toLowerCase().includes("applied") || postApplyText.toLowerCase().includes("application submitted") || postApplyText.toLowerCase().includes("successfully applied");

            if (isConfirmedApplied) {
                logger.info(`✓ CONFIRMED PORTAL APPLICATION SUBMITTED for Job ID ${targetJob.id}`);
                await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [targetJob.id]);
                eventBus.publish("APPLICATION_SUBMITTED", { portal: "Naukri", jobId: targetJob.id, title: targetJob.title, company: targetJob.company });
                telemetry.Applied++;

                const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
                const tgMsg = `<b>Naukri Application Submitted</b>\n\n` +
                    `• <b>Portal</b>: <code>Naukri</code>\n` +
                    `• <b>Role</b>: <code>${targetJob.title}</code>\n` +
                    `• <b>Company</b>: <code>${targetJob.company}</code>\n` +
                    `• <b>Experience</b>: <code>${targetJob.experience}</code>\n` +
                    `• <b>Location</b>: <code>${targetJob.location}</code>\n` +
                    `• <b>Executed From</b>: <code>${executionHost}</code>\n` +
                    `• <b>Time (IST)</b>: <code>${nowIst}</code>`;

                await telegramService.sendMessage(tgMsg).catch(e => logger.error(`Telegram send error: ${e.message}`));
            } else {
                logger.warn(`⚠️ Unverified application state for Job ID ${targetJob.id}. Marking CLICKED_UNVERIFIED.`);
                await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [targetJob.id]);
                telemetry.Failed++;
            }

            await jobPage.close().catch(() => {});
            await delay(3000); // Inter-application delay
        }

        saveTelemetry();
        logger.info("\n==================================================");
        logger.info("NAUKRI PRODUCTION RUN SUMMARY");
        logger.info(`Discovered:        ${telemetry.Discovered}`);
        logger.info(`Role Eligible:     ${telemetry.RoleEligible}`);
        logger.info(`Attempted:         ${telemetry.Attempted}`);
        logger.info(`Applied Verified:  ${telemetry.Applied}`);
        logger.info(`Waiting For Input: ${telemetry.WaitingForInput}`);
        logger.info(`External Required: ${telemetry.ExternalRequired}`);
        logger.info(`Failed/Unverified: ${telemetry.Failed}`);
        logger.info("==================================================");

    } catch (err) {
        logger.error(`❌ Naukri Production Runner Exception: ${err.message}`);
        await NaukriDiagnostics.persist(discoveryPage, null, "PRODUCTION_EXCEPTION");
        telemetry.zeroApplicationReason = "RUNNER_EXCEPTION";
        saveTelemetry();
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (process.platform === "win32") {
            await pushDatabase().catch(() => {});
        }
        lock.release();
    }
})();
