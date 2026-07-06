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

// 09:00 Profile Update & Job Search (populating DB)
registerCron("0 9 * * *", "Morning Naukri Profile Update", "naukri", "updateProfile");
registerCron("0 9 * * *", "Morning Naukri Job Search", "naukri", "search", { keywords: "Software Engineer", location: "Bangalore" });

// 09:05 Apply Jobs
registerCron("5 9 * * *", "Morning Naukri Job Apply", "naukri", "apply", { limit: 10 });

// 14:00 Profile Update & Job Search
registerCron("0 14 * * *", "Afternoon Naukri Profile Update", "naukri", "updateProfile");
registerCron("0 14 * * *", "Afternoon Naukri Job Search", "naukri", "search", { keywords: "Software Engineer", location: "Bangalore" });

// 14:05 Apply Jobs
registerCron("5 14 * * *", "Afternoon Naukri Job Apply", "naukri", "apply", { limit: 10 });

// Daily Summary cron at 20:00 (8:00 PM)
try {
    new CronJob("0 20 * * *", async () => {
        logger.scheduler.info("Triggering Daily Summary metrics computation...");
        await db.init();
        
        const appliedToday = await db.get(
            "SELECT COUNT(*) as count FROM jobs WHERE applied = 1 AND date(timestamp) = date('now')"
        );
        const totalJobs = await db.get("SELECT COUNT(*) as count FROM jobs");
        const failedTasks = await db.get(
            "SELECT COUNT(*) as count FROM tasks WHERE status = 'failed' AND date(created_at) = date('now')"
        );

        const countApplied = appliedToday ? appliedToday.count : 0;
        const countTotal = totalJobs ? totalJobs.count : 0;
        const countFailed = failedTasks ? failedTasks.count : 0;

        await telegramService.sendMessage(
            `📊 *Daily Job Automation Summary*\n\n` +
            `• *Jobs Applied Today*: *${countApplied}*\n` +
            `• *Total Jobs in DB*: *${countTotal}*\n` +
            `• *Failed Runs Today*: *${countFailed}*\n` +
            `• *Status*: Operational 🟢`
        );
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
