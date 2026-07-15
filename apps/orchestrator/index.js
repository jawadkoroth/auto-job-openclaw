const { CronJob } = require("cron");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const taskQueue = require("../../packages/queue/TaskQueue");
const telegramService = require("../telegram");
const aiService = require("../../packages/ai");
const eventBus = require("../../packages/events/EventBus");
const db = require("../../packages/database");

logger.scheduler.info("Starting central Orchestrator engine...", { action: "orchestrator_init" });

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
const portals = Object.keys(config.portals || {});
const activePortals = portals.filter(portal => {
    if (portal === "naukri" || portal === "linkedin") return false;
    const envKey = `ENABLE_${portal.toUpperCase()}`;
    let envVal = process.env[envKey];
    if (portal === "weworkremotely" && envVal === undefined) {
        envVal = process.env.ENABLE_WWR;
    }
    if (envVal !== undefined) {
        return envVal.toLowerCase() === "true";
    }
    return true; // default enabled
});

logger.scheduler.info(`Active portals loaded: ${activePortals.join(", ")}`);

// Setup Cron schedules for enabled active portals
for (const portal of activePortals) {
    const keywords = process.env.SEARCH_KEYWORDS || "DevOps Engineer";
    
    // 09:00 Profile Refresh & Search
    registerCron("0 9 * * *", `Morning ${portal} Profile Refresh`, portal, "updateProfile");
    registerCron("0 9 * * *", `Morning ${portal} Job Search`, portal, "search", { keywords });
    
    // 09:05 Apply
    registerCron("5 9 * * *", `Morning ${portal} Job Apply`, portal, "apply", { limit: 10 });
    
    // 14:00 Profile Refresh & Search
    registerCron("0 14 * * *", `Afternoon ${portal} Profile Refresh`, portal, "updateProfile");
    registerCron("0 14 * * *", `Afternoon ${portal} Job Search`, portal, "search", { keywords });
    
    // 14:05 Apply
    registerCron("5 14 * * *", `Afternoon ${portal} Job Apply`, portal, "apply", { limit: 10 });
}

// Daily Summary cron at 20:00 (8:00 PM IST)
try {
    new CronJob("0 20 * * *", async () => {
        logger.scheduler.info("Triggering Daily Summary metrics computation...");
        await db.init();
        
        let summaryRows = [];
        let totalJobsFound = 0;
        let totalEligible = 0;
        let successfullyApplied = 0;
        let waitingForInput = 0;
        let externalUnsupported = 0;
        let failed = 0;

        for (const portal of ["foundit", "hirist", "instahyre", "wellfound", "remoteok", "weworkremotely"]) {
            try {
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
                
                // External today
                const externalRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'EXTERNAL_PENDING' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const external = externalRes ? externalRes.count : 0;
                externalUnsupported += external;
                
                // Waiting today
                const waitingRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'WAITING_FOR_INPUT' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const waiting = waitingRes ? waitingRes.count : 0;
                waitingForInput += waiting;

                // Failed today
                const failedRes = await db.get(
                    `SELECT COUNT(*) as count FROM jobs 
                     WHERE portal = ? AND status = 'FAILED' AND date(timestamp) = date('now')`,
                    [portal]
                );
                const failedCount = failedRes ? failedRes.count : 0;
                failed += failedCount;
                
                summaryRows.push({
                    portal,
                    found,
                    eligible,
                    applied,
                    external,
                    waiting,
                    failed: failedCount
                });
            } catch (err) {
                logger.scheduler.error(`Failed to collect summary for ${portal}: ${err.message}`);
            }
        }

        // Format Daily Summary message exactly as requested
        let message = `🏁 *JOB AUTOMATION DAILY SUMMARY*\n\n`;
        message += "Portal | Found | Eligible | Applied | External | Waiting | Failed\n";
        message += "---------------------------------------------------------\n";
        for (const row of summaryRows) {
            message += `${row.portal} | ${row.found} | ${row.eligible} | ${row.applied} | ${row.external} | ${row.waiting} | ${row.failed}\n`;
        }
        message += "\n";
        message += `• *Total Jobs Found*: ${totalJobsFound}\n`;
        message += `• *Total Eligible*: ${totalEligible}\n`;
        message += `• *Successfully Applied*: ${successfullyApplied}\n`;
        message += `• *Waiting for Input*: ${waitingForInput}\n`;
        message += `• *External Unsupported*: ${externalUnsupported}\n`;
        message += `• *Failed*: ${failed}\n\n`;
        
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
        } else if (text.startsWith("/approve")) {
            const parts = text.split(" ");
            const jobId = parts[1];
            if (!jobId) {
                await telegramService.sendMessage("❌ Usage: `/approve <job_id> [optional custom answer]`");
                return;
            }
            
            await db.init();
            const job = await db.get("SELECT * FROM jobs WHERE id = ?", [jobId]);
            if (!job) {
                await telegramService.sendMessage(`❌ Job with ID \`${jobId}\` not found in database.`);
                return;
            }
            
            let finalAnswer = parts.slice(2).join(" ").trim();
            if (!finalAnswer) {
                finalAnswer = job.pending_suggested_answer || "Yes";
            }
            
            // Save to Q&A memory
            const normalizedQ = job.pending_question ? job.pending_question.toLowerCase().replace(/[^a-z0-9]/g, "").trim() : "default_q";
            await db.run(
                `INSERT OR REPLACE INTO qna_memory (question_normalized, question_raw, answer, answer_type, source, approved)
                 VALUES (?, ?, ?, 'APPROVED', 'TELEGRAM', 1)`,
                [normalizedQ, job.pending_question, finalAnswer]
            );
            
            // Set job back to ELIGIBLE (or status = 'ELIGIBLE') and clear pending
            await db.run(
                "UPDATE jobs SET status = 'ELIGIBLE', ignored = 0, applied = 0, pending_question = NULL, pending_suggested_answer = NULL WHERE id = ?",
                [jobId]
            );
            
            await telegramService.sendMessage(
                `✅ *Approved answer for ${job.company} - ${job.title}*:\n` +
                `_"${finalAnswer}"_\n\n` +
                `The job has been marked as *ELIGIBLE* and will be applied to during the next scheduler run.`
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
