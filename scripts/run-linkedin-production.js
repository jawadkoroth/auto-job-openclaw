const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").plugin("linkedin");
const eventBus = require("../packages/events/EventBus");
const telegramService = require("../apps/telegram");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");

const LinkedInSessionBootstrap = require("../packages/plugins/linkedin/LinkedInSessionBootstrap");
const LinkedInConcurrencyLock = require("../packages/plugins/linkedin/LinkedInConcurrencyLock");
const linkedinDiscovery = require("../packages/plugins/linkedin/LinkedInDiscovery");
const linkedinApplyEngine = require("../packages/plugins/linkedin/LinkedInApplyEngine");
const linkedinVerification = require("../packages/plugins/linkedin/LinkedInVerification");
const oraclePersistence = require("../packages/plugins/linkedin/LinkedInPersistence");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_APPLICATIONS_PER_RUN = parseInt(process.env.LINKEDIN_MAX_APPLICATIONS_PER_RUN || process.env.MAX_APPLICATIONS_PER_RUN || "10", 10);
const MAX_APPLICATIONS_PER_DAY = parseInt(process.env.LINKEDIN_MAX_APPLICATIONS_PER_DAY || process.env.MAX_APPLICATIONS_PER_DAY || "20", 10);

(async () => {
    const startTime = Date.now();
    const isDryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    logger.info("==================================================");
    logger.info("LINKEDIN HARDENED PRODUCTION AUTOMATION RUNNER");
    logger.info(`Execution Host: ${executionHost}`);
    logger.info(`Mode: ${isDryRun ? "DRY RUN (No Applications Submitted)" : "ACTIVE PRODUCTION (Live Submissions)"}`);
    logger.info(`Execution Time: ${new Date().toISOString()}`);
    logger.info(`Limits: Max ${MAX_APPLICATIONS_PER_RUN} per run, Max ${MAX_APPLICATIONS_PER_DAY} per day`);
    logger.info("==================================================\n");

    const lock = new LinkedInConcurrencyLock("linkedin_job_automation.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ linkedin_job_automation runner is already executing. Exiting as SKIPPED_ALREADY_RUNNING.");
        process.exit(0);
    }

    await oraclePersistence.flushOutbox().catch(() => {});

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
        EasyApplied: 0,
        ExternalApplied: 0,
        WaitingForInput: 0,
        Failed: 0,
        zeroApplicationReason: null,
        dailyLimit: MAX_APPLICATIONS_PER_DAY,
        dailyAppliedCount: 0,
        dailyRemainingCapacity: 0
    };

    const saveTelemetry = () => {
        try {
            const sessionPath = path.join(process.cwd(), "sessions", "linkedin");
            fs.mkdirpSync(sessionPath);
            fs.writeJsonSync(path.join(sessionPath, "last_run_telemetry.json"), telemetry, { spaces: 2 });
        } catch (e) {}
    };

    const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const appliedToday = await oraclePersistence.getDailyAppliedCount(todayIst);
    telemetry.dailyAppliedCount = appliedToday;
    telemetry.dailyRemainingCapacity = Math.max(0, MAX_APPLICATIONS_PER_DAY - appliedToday);

    logger.info(`Daily LinkedIn Applications Counter (IST: ${todayIst}): ${appliedToday} / ${MAX_APPLICATIONS_PER_DAY} (Remaining: ${telemetry.dailyRemainingCapacity})`);

    if (appliedToday >= MAX_APPLICATIONS_PER_DAY && !isDryRun) {
        logger.warn("⚠️ Daily LinkedIn application limit reached. Skipping further submissions today.");
        telemetry.zeroApplicationReason = "DAILY_LIMIT_REACHED";
        saveTelemetry();
        lock.release();
        process.exit(0);
    }

    // 1. Session Bootstrap
    const storageStatePath = path.join(process.cwd(), "sessions", "linkedin", "storageState.json");
    const bootstrapHelper = new LinkedInSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status === "SESSION_EXPIRED" || boot.status === "CHALLENGE_REQUIRED" || !boot.page) {
        logger.error(`❌ Session bootstrap halted with status ${boot.status}`);
        telemetry.zeroApplicationReason = boot.status;
        saveTelemetry();
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    const { browser, context, page } = boot;

    try {
        // 2. Discovery & Ranking
        logger.info("[Step 2] Discovering target DevOps/Cloud/Platform candidate jobs on LinkedIn...");
        const discovered = await linkedinDiscovery.discoverJobs(page, {
            keywords: ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "Infrastructure Engineer"],
            location: "India",
            maxResults: 20
        });

        telemetry.Discovered = discovered.length;
        telemetry.discoveryStatus = "SUCCESS";

        if (discovered.length === 0) {
            logger.info("ℹ️ No target candidate jobs discovered on LinkedIn during this run.");
            telemetry.zeroApplicationReason = "NO_JOBS_DISCOVERED";
            saveTelemetry();
            await browser.close().catch(() => {});
            lock.release();
            process.exit(0);
        }

        // 3. Filter Duplicates & Process Candidates
        const validCandidates = [];
        for (const job of discovered) {
            const jobId = job.id || job.job_id;
            const isDup = await oraclePersistence.isDuplicateJob(jobId, job.url);
            if (isDup) {
                telemetry.Duplicates++;
                logger.info(`[Filter] Job ID ${jobId} is already in Oracle DB / Outbox as applied. Skipping.`);
                continue;
            }

            await oraclePersistence.recordJob(job);
            validCandidates.push(job);

            if (validCandidates.length >= MAX_APPLICATIONS_PER_RUN) break;
        }

        telemetry.FinalCandidates = validCandidates.length;
        logger.info(`[Step 3] ${validCandidates.length} final candidate jobs ready for Easy Apply engine processing.`);

        // 4. Easy Apply Engine Loop
        for (const job of validCandidates) {
            const jobId = job.id || job.job_id;
            telemetry.Attempted++;

            logger.info(`\n--------------------------------------------------`);
            logger.info(`Processing Job: '${job.title}' at '${job.company}' (ID: ${jobId})`);
            logger.info(`Score: ${job.rankScore} | Selection Reason: ${job.selectionReason}`);

            await oraclePersistence.updateJobStatus(jobId, "APPLYING", 0);

            const result = await linkedinApplyEngine.applyJob(page, job, { dryRun: isDryRun });

            if (result.status === "DRY_RUN_COMPLETED") {
                telemetry.Applied++;
                telemetry.EasyApplied++;
                await oraclePersistence.updateJobStatus(jobId, "DRY_RUN_PASSED", 0);
                await oraclePersistence.recordEvent(`evt_dry_${Date.now()}`, jobId, "linkedin", "DRY_RUN_PASSED", { jobTitle: job.title });
                logger.info(`✅ [DRY_RUN] Successfully completed form navigation for Job ${jobId}.`);
                continue;
            }

            if (result.status === "WAITING_FOR_INPUT") {
                telemetry.WaitingForInput++;
                await oraclePersistence.updateJobStatus(jobId, "WAITING_FOR_INPUT", 0);
                await oraclePersistence.recordEvent(`evt_wfi_${Date.now()}`, jobId, "linkedin", "WAITING_FOR_INPUT", { question: result.questionText });
                logger.warn(`⚠️ Job ${jobId} set to WAITING_FOR_INPUT.`);
                continue;
            }

            if (result.status === "SUBMITTED") {
                const verifyResult = await linkedinVerification.verifyApplication(page, job);
                if (verifyResult.verified) {
                    telemetry.Applied++;
                    telemetry.EasyApplied++;
                    await oraclePersistence.updateJobStatus(jobId, "APPLIED", 1);
                    await oraclePersistence.recordEvent(`evt_app_${Date.now()}`, jobId, "linkedin", "APPLICATION_SUBMITTED", { verified: true });
                    
                    const tgMsg = `<b>✅ LinkedIn Easy Apply Submitted</b>\n\n` +
                        `• <b>Title</b>: <code>${job.title}</code>\n` +
                        `• <b>Company</b>: <code>${job.company}</code>\n` +
                        `• <b>Rank Score</b>: <code>${job.rankScore}</code>\n` +
                        `• <b>Host</b>: <code>${executionHost}</code>`;
                    await telegramService.sendMessage(tgMsg).catch(() => {});

                } else {
                    telemetry.Failed++;
                    await oraclePersistence.updateJobStatus(jobId, "UNVERIFIED", 0);
                }
            } else {
                telemetry.Failed++;
                await oraclePersistence.updateJobStatus(jobId, result.status || "FAILED", 0);
            }

            await delay(2000);
        }

        saveTelemetry();

        // 5. Final Telegram Execution Summary Notification
        const summaryMsg = `<b>📊 LinkedIn Automation Run Summary</b>\n\n` +
            `• <b>Host</b>: <code>${executionHost}</code>\n` +
            `• <b>Mode</b>: <code>${isDryRun ? "DRY_RUN" : "LIVE"}</code>\n` +
            `• <b>Discovered</b>: <code>${telemetry.Discovered}</code>\n` +
            `• <b>Attempted</b>: <code>${telemetry.Attempted}</code>\n` +
            `• <b>Applied / Passed</b>: <code>${telemetry.Applied}</code>\n` +
            `• <b>Waiting For Input</b>: <code>${telemetry.WaitingForInput}</code>\n` +
            `• <b>Daily Progress</b>: <code>${telemetry.dailyAppliedCount + telemetry.Applied} / ${MAX_APPLICATIONS_PER_DAY}</code>`;

        await telegramService.sendMessage(summaryMsg).catch(() => {});
        logger.info(`\n==================================================`);
        logger.info(`RUN COMPLETED. Total Applied/Passed: ${telemetry.Applied}/${telemetry.Attempted}`);
        logger.info(`==================================================\n`);

    } catch (err) {
        logger.error(`❌ Main LinkedIn execution error: ${err.message}`);
    } finally {
        await browser.close().catch(() => {});
        await oraclePersistence.flushOutbox().catch(() => {});
        lock.release();
    }
})();
