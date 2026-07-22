const { CronJob } = require("cron");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const taskQueue = require("../../packages/queue/TaskQueue");
const telegramService = require("../telegram");
const aiService = require("../../packages/ai");
const eventBus = require("../../packages/events/EventBus");
const db = require("../../packages/database");

logger.scheduler.info("Starting central Orchestrator engine...", { action: "orchestrator_init" });
logger.scheduler.info(`[LIMITS] Max applications per run: ${config.search.maxApplicationsPerRun}`);
logger.scheduler.info(`[LIMITS] Max applications per portal: ${config.search.maxApplicationsPerPortal}`);

// 1. Subscribe ONLY the required Telegram notifications to the Event Bus
eventBus.on("WorkerFinished", async (data) => {
    const { taskId, portal, action, success, result, error, screenshotPath } = data;
    
    if (success) {
        if (action === "updateProfile") {
            await telegramService.sendMessage(`👤 *Profile Updated*: \`${portal}\` profile updated successfully.`);
        } else if (action === "apply") {
            const count = result ? (result.appliedCount || 0) : 0;
            await telegramService.sendMessage(`💼 *Jobs Applied*: Successfully applied to *${count}* matching jobs on \`${portal}\`.`);
        }
    } else {
        // Failures
        const errorMsg = error || "Unknown execution error";
        if (screenshotPath) {
            await telegramService.sendPhoto(
                screenshotPath,
                `❌ *Failure Alert* on \`${portal}.${action}\` (Task ID: \`${taskId.substring(0, 8)}\`)\nError: \`${errorMsg}\``
            );
        } else {
            await telegramService.sendMessage(`❌ *Failure Alert* on \`${portal}.${action}\` (Task ID: \`${taskId.substring(0, 8)}\`)\nError: \`${errorMsg}\``);
        }
    }
});

// 2. Setup Cron schedule bindings at exact requested timings
function registerCron(cronTime, label, portal, action, args = {}) {
    try {
        new CronJob(cronTime, async () => {
            logger.scheduler.info(`Cron triggered: "${label}". Queueing task.`);
            const id = await taskQueue.push(portal, action, args);
            logger.scheduler.info(`Task queued successfully: ${id}`);
        }, null, true, "Asia/Kolkata");
        logger.scheduler.info(`Registered scheduler: "${label}" -> [${cronTime}]`);
    } catch (e) {
        logger.scheduler.error(`Failed to register scheduler job "${label}": ${e.message}`);
    }
}

// Determine active portals dynamically from configuration and environment flags
const { validatePortalConfig } = require("../../packages/config/validation");

// Initialize schedules after database and portal validation
(async () => {
    await db.init();

    const portals = Object.keys(config.portals || {});
    const activePortals = [];

    for (const portal of portals) {
        try {
            const validation = await validatePortalConfig(portal);
            if (validation.status === "SKIPPED") {
                logger.scheduler.info(`Portal [${portal}] is disabled/skipped.`);
                continue;
            }
            if (validation.status === "CONFIG_REQUIRED") {
                logger.scheduler.warn(`[${portal}] CONFIG_REQUIRED: Missing authentication configuration.`);
                logger.scheduler.warn(`Required: ${validation.requiredMessage}`);
                continue;
            }
            if (validation.status === "AUTH_REQUIRED") {
                logger.scheduler.warn(`[${portal}] AUTH_REQUIRED: Session expired. Skipping automatic runs.`);
                continue;
            }
            activePortals.push(portal);
        } catch (err) {
            logger.scheduler.error(`Failed to validate config for portal ${portal}: ${err.message}`);
        }
    }

    logger.scheduler.info(`Active configured portals for scheduled runs: ${activePortals.join(", ")}`);

    // Setup Cron schedules for enabled and configured active portals
    for (const portal of activePortals) {
        const keywords = process.env.SEARCH_KEYWORDS || "DevOps Engineer";
        
        // 09:00 Profile Maintenance / Update Tasks
        registerCron("0 9 * * *", `Morning ${portal} Profile Refresh`, portal, "updateProfile");
        
        // 09:05 Job Search and Application run
        registerCron("5 9 * * *", `Morning ${portal} Job Search`, portal, "search", { keywords });
        registerCron("5 9 * * *", `Morning ${portal} Job Apply`, portal, "apply", { limit: 10 });
        
        // 14:00 Profile Maintenance / Update Tasks
        registerCron("0 14 * * *", `Afternoon ${portal} Profile Refresh`, portal, "updateProfile");
        
        // 14:05 Job Search and Application run
        registerCron("5 14 * * *", `Afternoon ${portal} Job Search`, portal, "search", { keywords });
        registerCron("5 14 * * *", `Afternoon ${portal} Job Apply`, portal, "apply", { limit: 10 });
    }
})();

// Daily Summary cron at 20:00 (8:00 PM IST)
try {
    new CronJob("0 20 * * *", async () => {
        logger.scheduler.info("Triggering Daily Summary metrics computation...");
        await db.init();
        
        let summaryRows = [];
        let totalJobsFound = 0;
        let totalEligible = 0;
        let successfullyApplied = 0;
        let totalAlreadyApplied = 0;
        let totalExternalPending = 0;
        let totalWaitingForInput = 0;
        let totalQuestionnaireSkipped = 0;
        let totalFailed = 0;

        const portalsList = ["foundit", "hirist", "instahyre", "wellfound", "remoteok", "weworkremotely"];

        for (const portal of portalsList) {
            try {
                // Get portal execution status (PASS/FAIL/CONFIG_REQUIRED/AUTH_REQUIRED/SKIPPED)
                const validation = await validatePortalConfig(portal);
                let portalStatus = validation.status;

                if (portalStatus === "PASS") {
                    // Check if there was any task failure today for this portal
                    const taskFail = await db.get(
                        "SELECT COUNT(*) as count FROM tasks WHERE portal = ? AND status = 'failed' AND date(created_at) = date('now')",
                        [portal]
                    );
                    if (taskFail && taskFail.count > 0) {
                        portalStatus = "FAIL";
                    }
                }

                // Found today
                const foundRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND date(timestamp) = date('now')",
                    [portal]
                );
                const found = foundRes ? foundRes.count : 0;
                totalJobsFound += found;
                
                // Eligible today
                const eligibleRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? 
                       AND (applied = 1 OR status IN ('ELIGIBLE', 'APPLIED', 'CLICKED_UNVERIFIED', 'EXTERNAL_PENDING', 'WAITING_FOR_INPUT'))
                       AND date(timestamp) = date('now')`,
                    [portal]
                );
                const eligible = eligibleRes ? eligibleRes.count : 0;
                totalEligible += eligible;
                
                // Applied today
                const appliedRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND (applied = 1 OR status = 'APPLIED') AND date(timestamp) = date('now')`,
                    [portal]
                );
                const applied = appliedRes ? appliedRes.count : 0;
                successfullyApplied += applied;
                
                // Already Applied today
                const alreadyAppliedRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'ALREADY_APPLIED' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const alreadyApplied = alreadyAppliedRes ? alreadyAppliedRes.count : 0;
                totalAlreadyApplied += alreadyApplied;

                // External today
                const externalRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'EXTERNAL_PENDING' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const external = externalRes ? externalRes.count : 0;
                totalExternalPending += external;
                
                // Waiting today
                const waitingRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'WAITING_FOR_INPUT' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const waiting = waitingRes ? waitingRes.count : 0;
                totalWaitingForInput += waiting;

                // Questionnaire Skipped today
                const qnSkippedRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'QUESTIONNAIRE_SKIPPED' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const qnSkipped = qnSkippedRes ? qnSkippedRes.count : 0;
                totalQuestionnaireSkipped += qnSkipped;

                // Failed today
                const failedRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'FAILED' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const failedCount = failedRes ? failedRes.count : 0;
                totalFailed += failedCount;
                
                summaryRows.push({
                    portal,
                    found,
                    eligible,
                    applied,
                    alreadyApplied,
                    external,
                    waiting,
                    qnSkipped,
                    failed: failedCount,
                    status: portalStatus
                });
            } catch (err) {
                logger.scheduler.error(`Failed to collect summary for ${portal}: ${err.message}`);
            }
        }

        // Fetch remaining limits and counts across all time
        const dbWaitingCount = (await db.get("SELECT COUNT(*) as count FROM jobs WHERE status = 'WAITING_FOR_INPUT'")).count;
        const dbExternalCount = (await db.get("SELECT COUNT(*) as count FROM jobs WHERE status = 'EXTERNAL_PENDING'")).count;

        const maxRunLimit = parseInt(process.env.MAX_APPLICATIONS_PER_RUN || "20", 10);
        const remainingLimit = Math.max(0, maxRunLimit - successfullyApplied);

        // Format Daily Summary message exactly as requested
        let message = `🏁 *JOB AUTOMATION DAILY SUMMARY*\n\n`;
        message += "```\n";
        message += "Portal | Found | Eligible | Applied | Already | External | Waiting | QnSkip | Failed | Status\n";
        message += "------------------------------------------------------------------------------------------\n";
        for (const row of summaryRows) {
            message += `${row.portal.padEnd(8)} | ${String(row.found).padEnd(5)} | ${String(row.eligible).padEnd(8)} | ${String(row.applied).padEnd(7)} | ${String(row.alreadyApplied).padEnd(7)} | ${String(row.external).padEnd(8)} | ${String(row.waiting).padEnd(7)} | ${String(row.qnSkipped).padEnd(6)} | ${String(row.failed).padEnd(6)} | ${row.status}\n`;
        }
        message += "```\n\n";
        message += `• *Total Applications Today*: ${successfullyApplied}\n`;
        message += `• *Remaining Application Limit*: ${remainingLimit}\n`;
        message += `• *Pending External Applications*: ${dbExternalCount}\n`;
        message += `• *Waiting for User Input*: ${dbWaitingCount}\n`;
        message += `• *Scheduler Status*: active\n`;
        message += `• *Worker Status*: active\n\n`;
        
        // Next Scheduled Run Calculation
        message += `📅 *Next Scheduled Run*: Tomorrow 09:00 IST`;

        await telegramService.sendMessage(message);
    }, null, true, "Asia/Kolkata");
    logger.scheduler.info("Registered Daily Summary scheduler -> [0 20 * * *]");
} catch (e) {
    logger.scheduler.error(`Failed to register Daily Summary schedule: ${e.message}`);
}

// 3. Launch Telegram polling command listener
telegramService.startPolling(async (message) => {
    const text = message.text.trim();
    
    if (text.startsWith("/")) {
        if (text === "/start") {
            await telegramService.sendMessage(
                `👋 *OpenClaw AI Orchestrator Online!*\n\n` +
                `Send commands to queue operations:\n` +
                `• _"Search for DevOps jobs"_ \n` +
                `• _"Apply to jobs on Hirist"_\n` +
                `• _"Update my profile"_\n\n` +
                `Use /status to inspect queue health.`
            );
        } else if (text === "/status") {
            const pendingCount = await taskQueue.getPendingCount();
            await telegramService.sendMessage(
                `🟢 *System Health*: Operational\n` +
                `• *Queued tasks*: ${pendingCount}\n` +
                `• *Scheduler*: active`
            );
        } else if (text.startsWith("/approve") || text.startsWith("/answer") || text.startsWith("/useonce")) {
            const isUseOnce = text.startsWith("/useonce");
            const parts = text.split(" ");
            const targetId = parts[1];
            if (!targetId) {
                await telegramService.sendMessage(
                    "❌ Usage:\n" +
                    "• <code>/answer &lt;approval_id&gt; &lt;answer&gt;</code> (Save for future applications)\n" +
                    "• <code>/useonce &lt;approval_id&gt; &lt;answer&gt;</code> (Use ONCE, do not save to Answer Bank)\n" +
                    "• <code>/approve &lt;approval_id&gt;</code> (Approve suggested answer for future)"
                );
                return;
            }
            
            await db.init();
            const job = await db.get(
                "SELECT * FROM jobs WHERE approval_id = ? OR pending_question_id = ? OR id = ? OR job_id = ? ORDER BY id DESC LIMIT 1",
                [targetId, targetId, targetId, targetId]
            );
            if (!job) {
                await telegramService.sendMessage(`❌ Pending question record with ID <code>${telegramService.escapeHTML(targetId)}</code> not found in database.`);
                return;
            }
            
            let finalAnswer = parts.slice(2).join(" ").trim();
            if (!finalAnswer) {
                finalAnswer = job.pending_suggested_answer || "Decline to self-identify";
            }
            
            const candidateKnowledgeService = require("../../packages/knowledge/CandidateKnowledgeService");

            if (!isUseOnce) {
                // Save to reusable Answer Bank for future applications (Task 4)
                await candidateKnowledgeService.answerBank.saveAnswer({
                    question: job.pending_question || "Application Question",
                    answer: finalAnswer,
                    answerType: "FACTUAL"
                });
            }
            
            // Set job back to ELIGIBLE and clear pending fields
            await db.run(
                "UPDATE jobs SET status = 'ELIGIBLE', ignored = 0, applied = 0, pending_question = NULL, pending_suggested_answer = NULL, pending_question_id = NULL, approval_id = NULL WHERE id = ?",
                [job.id]
            );
            
            const saveMode = isUseOnce ? "<b>USE ONCE ONLY</b> (Not saved to Answer Bank)" : "<b>SAVED FOR FUTURE</b> (Added to Answer Bank)";
            await telegramService.sendMessage(
                `✅ <b>Approved answer for ${telegramService.escapeHTML(job.company || 'Company')} - ${telegramService.escapeHTML(job.title || 'Job')}</b>:\n` +
                `<i>"${telegramService.escapeHTML(finalAnswer)}"</i>\n` +
                `Mode: ${saveMode}\n\n` +
                `The job has been marked as <b>ELIGIBLE</b> for retry.`
            );
        } else {
            await telegramService.sendMessage(`❓ Command not recognized. Send /start to get help.`);
        }
        return;
    }

    await telegramService.sendMessage(`🤖 *OpenClaw AI* is parsing: "${text}"...`);
    
    try {
        const parsed = await aiService.parseCommand(text);
        
        await telegramService.sendMessage(
            `🎯 *Parsed Command*:\n` +
            `• *Portal*: \`${parsed.plugin}\`\n` +
            `• *Action*: \`${parsed.action}\`\n` +
            `• *Params*: \`${JSON.stringify(parsed.args)}\`\n\n` +
            `Registering task in SQLite queue...`
        );

        const taskId = await taskQueue.push(parsed.plugin, parsed.action, parsed.args);
        await telegramService.sendMessage(`✅ *Task Queued* (Task ID: \`${taskId.substring(0, 8)}\`). Processing starting shortly.`);
    } catch (err) {
        logger.scheduler.error(`Command parsing failed: ${err.message}`);
        await telegramService.sendMessage(`❌ *Error*: Parsing failed: \`${err.message}\``);
    }
});

// Initialize DB and announce launch (Platform Started)
db.init().then(() => {
    telegramService.sendMessage("🚀 *Platform Started*: Job automation orchestrator is online and active.");
}).catch(err => {
    console.error("Orchestrator failed starting database:", err);
});
