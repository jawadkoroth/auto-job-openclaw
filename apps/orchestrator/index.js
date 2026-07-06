const { CronJob } = require("cron");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const taskQueue = require("../../packages/queue/TaskQueue");
const telegramService = require("../telegram");
const aiService = require("../../packages/ai");
const eventBus = require("../../packages/events/EventBus");
const db = require("../../packages/database");

logger.scheduler.info("Starting central Orchestrator engine...", { action: "orchestrator_init" });

// 1. Subscribe Telegram notifications to the decoupled Event Bus
eventBus.on("BrowserStarted", ({ portal, taskId }) => {
    telegramService.sendMessage(`🌐 *Browser Launched* for portal: \`${portal}\` (Task ID: \`${taskId.substring(0, 8)}\`)`);
});

eventBus.on("LoginSucceeded", ({ portal }) => {
    telegramService.sendMessage(`🔑 *Login Success*: Authenticated successfully on \`${portal}\`.`);
});

eventBus.on("LoginFailed", ({ portal }) => {
    telegramService.sendMessage(`⚠️ *Login Failed*: Could not verify authentication on \`${portal}\`.`);
});

eventBus.on("JobFound", ({ portal, job }) => {
    telegramService.sendMessage(`🔍 *Job Found*: \`${job.title}\` at \`${job.company}\` (${portal}) added to database.`);
});

eventBus.on("JobApplied", ({ portal, job }) => {
    telegramService.sendMessage(`✅ *Job Applied*: Submitted application for \`${job.title}\` at \`${job.company}\`.`);
});

eventBus.on("PluginCrashed", ({ portal, action, error, screenshotPath }) => {
    if (screenshotPath) {
        telegramService.sendPhoto(
            screenshotPath,
            `❌ *Plugin Crash*: \`${portal}.${action}\` failed.\nError: \`${error}\``
        );
    } else {
        telegramService.sendMessage(`❌ *Plugin Crash*: \`${portal}.${action}\` failed.\nError: \`${error}\``);
    }
});

// 2. Setup Cron schedule bindings (pushing tasks to queue instead of running directly)
function registerCron(cronTime, label, portal, action, args = {}) {
    try {
        new CronJob(cronTime, async () => {
            logger.scheduler.info(`Scheduled cron trigger: "${label}". Pushing to queue.`);
            const id = await taskQueue.push(portal, action, args);
            logger.scheduler.info(`Task successfully registered in queue: ${id}`);
        }, null, true, "Asia/Kolkata");
        logger.scheduler.info(`Registered scheduler job: "${label}" on cron: [${cronTime}]`);
    } catch (e) {
        logger.scheduler.error(`Failed to register scheduled job "${label}": ${e.message}`);
    }
}

// Register crons based on configurations
if (config.portals.naukri.scheduleUpdate) {
    registerCron(config.portals.naukri.scheduleUpdate, "Naukri Profile Update Run", "naukri", "updateProfile");
}
if (config.portals.naukri.scheduleApply) {
    registerCron(config.portals.naukri.scheduleApply, "Naukri Job Search Run", "naukri", "search", { keywords: "Software Engineer", location: "Bangalore" });
    // Offset apply run 10 minutes later to allow search to finish
    const offsetApplyCron = config.portals.naukri.scheduleApply.replace("5 ", "15 ");
    registerCron(offsetApplyCron, "Naukri Job Application Run", "naukri", "apply", { limit: 5 });
}
if (config.portals.linkedin.scheduleApply) {
    registerCron(config.portals.linkedin.scheduleApply, "LinkedIn Job Search Run", "linkedin", "search", { keywords: "Software Engineer" });
    const offsetApplyCron = config.portals.linkedin.scheduleApply.replace("30 ", "40 ");
    registerCron(offsetApplyCron, "LinkedIn Job Application Run", "linkedin", "apply", { limit: 5 });
}

// 3. Launch Telegram polling command listener
telegramService.startPolling(async (message) => {
    const text = message.text.trim();
    
    if (text.startsWith("/")) {
        if (text === "/start") {
            await telegramService.sendMessage(
                `👋 *OpenClaw AI Orchestrator Online!*\n\n` +
                `Send natural language statements to schedule tasks:\n` +
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
            `🎯 *Command Translated*:\n` +
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

// Initialize DB and announce launch
db.init().then(() => {
    telegramService.sendMessage("⚙️ *Orchestrator online*. Scheduled cron jobs and Telegram listeners active.");
}).catch(err => {
    console.error("Orchestrator failed starting database:", err);
});
