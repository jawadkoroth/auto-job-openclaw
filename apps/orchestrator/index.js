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

// 09:00 Profile Update & Job Search (populating DB) - Naukri is ON HOLD
// registerCron("0 9 * * *", "Morning Naukri Profile Update", "naukri", "updateProfile");
// registerCron("0 9 * * *", "Morning Naukri Job Search", "naukri", "search", { keywords: "Software Engineer", location: "Bangalore" });

// 09:05 Apply Jobs - Naukri is ON HOLD
// registerCron("5 9 * * *", "Morning Naukri Job Apply", "naukri", "apply", { limit: 10 });

// 14:00 Profile Update & Job Search - Naukri is ON HOLD
// registerCron("0 14 * * *", "Afternoon Naukri Profile Update", "naukri", "updateProfile");
// registerCron("0 14 * * *", "Afternoon Naukri Job Search", "naukri", "search", { keywords: "Software Engineer", location: "Bangalore" });

// 14:05 Apply Jobs - Naukri is ON HOLD
// registerCron("5 14 * * *", "Afternoon Naukri Job Apply", "naukri", "apply", { limit: 10 });

// Register production schedules for each active portal independently
const activePortals = ["instahyre", "hirist", "foundit", "wellfound", "remoteok", "weworkremotely"];

for (const portal of activePortals) {
    // 09:00 Profile Refresh & Search
    registerCron("0 9 * * *", `Morning ${portal} Profile Refresh`, portal, "updateProfile");
    registerCron("0 9 * * *", `Morning ${portal} Job Search`, portal, "search");
    
    // 09:05 Apply
    registerCron("5 9 * * *", `Morning ${portal} Job Apply`, portal, "apply", { limit: 10 });
    
    // 14:00 Profile Refresh & Search
    registerCron("0 14 * * *", `Afternoon ${portal} Profile Refresh`, portal, "updateProfile");
    registerCron("0 14 * * *", `Afternoon ${portal} Job Search`, portal, "search");
    
    // 14:05 Apply
    registerCron("5 14 * * *", `Afternoon ${portal} Job Apply`, portal, "apply", { limit: 10 });
}

// Daily Summary cron at 20:00 (8:00 PM)
try {
    new CronJob("0 20 * * *", async () => {
        logger.scheduler.info("Triggering Daily Summary metrics computation...");
        await db.init();
        
        let summaryRows = [];
        for (const portal of activePortals) {
            try {
                // Jobs Found today
                const foundRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND date(timestamp) = date('now')",
                    [portal]
                );
                const found = foundRes ? foundRes.count : 0;
                
                // Applied today
                const appliedRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND applied = 1 AND date(timestamp) = date('now')",
                    [portal]
                );
                const applied = appliedRes ? appliedRes.count : 0;
                
                // Already Applied today
                const alreadyAppliedRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND reason = 'Already applied' AND date(timestamp) = date('now')",
                    [portal]
                );
                const alreadyApplied = alreadyAppliedRes ? alreadyAppliedRes.count : 0;
                
                // External today
                const externalRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND reason = 'External redirect' AND date(timestamp) = date('now')",
                    [portal]
                );
                const external = externalRes ? externalRes.count : 0;
                
                // Questionnaire today
                const questionnaireRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND reason = 'Questionnaire' AND date(timestamp) = date('now')",
                    [portal]
                );
                const questionnaire = questionnaireRes ? questionnaireRes.count : 0;

                // Failed today
                const failedRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND reason = 'Verification Failed' AND date(timestamp) = date('now')",
                    [portal]
                );
                const failed = failedRes ? failedRes.count : 0;
                
                // Skipped today
                const skippedRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND date(timestamp) = date('now')",
                    [portal]
                );
                const skipped = skippedRes ? skippedRes.count : 0;
                
                // Eligible today (Found - Filter Mismatches)
                const mismatchRes = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND ignored = 1 AND reason IN ('Keyword mismatch', 'Location mismatch', 'Experience mismatch') AND date(timestamp) = date('now')",
                    [portal]
                );
                const mismatchCount = mismatchRes ? mismatchRes.count : 0;
                const eligible = Math.max(0, found - mismatchCount);
                
                // Execution Time (duration of tasks today)
                const tasksToday = await db.all(
                    "SELECT created_at, updated_at FROM tasks WHERE portal = ? AND date(created_at) = date('now')",
                    [portal]
                );
                let totalSec = 0;
                for (const t of tasksToday) {
                    const diff = new Date(t.updated_at) - new Date(t.created_at);
                    if (diff > 0) totalSec += diff / 1000;
                }
                const execTime = totalSec > 60 ? `${Math.floor(totalSec / 60)}m ${Math.floor(totalSec % 60)}s` : `${Math.floor(totalSec)}s`;
                
                summaryRows.push({
                    portal,
                    found,
                    eligible,
                    applied,
                    skipped,
                    alreadyApplied,
                    external,
                    questionnaire,
                    failed,
                    execTime
                });
            } catch (err) {
                logger.scheduler.error(`Failed to collect summary for ${portal}: ${err.message}`);
            }
        }

        // Format Daily Summary message as requested
        let message = `📊 *Daily Job Automation Summary*\n\n`;
        message += "```\n";
        message += "Portal | Found | Eligible | Applied | Skipped | Already | External | Quest | Failed | Time\n";
        message += "-----------------------------------------------------------------------------------------\n";
        for (const row of summaryRows) {
            message += `${row.portal} | ${row.found} | ${row.eligible} | ${row.applied} | ${row.skipped} | ${row.alreadyApplied} | ${row.external} | ${row.questionnaire} | ${row.failed} | ${row.execTime}\n`;
        }
        message += "```\n";
        message += `Status: Operational 🟢`;

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
                `• _"Search for DevOps jobs in Bangalore on Naukri"_\n` +
                `• _"Apply to jobs on Naukri"_\n` +
                `• _"Update my Naukri profile"_\n\n` +
                `Use /status to inspect queue health.`
            );
        } else if (text === "/status") {
            const pendingCount = await taskQueue.getPendingCount();
            await telegramService.sendMessage(
                `🟢 *System Health*: Operational\n` +
                `• *Queued tasks*: ${pendingCount}\n` +
                `• *Scheduler*: active`
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
