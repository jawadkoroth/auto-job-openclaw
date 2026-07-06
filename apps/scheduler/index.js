const { CronJob } = require("cron");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const { runJob } = require("../worker");
const telegramService = require("../telegram");

logger.info("Initializing scheduled tasks engine...", { action: "scheduler_init" });

const scheduledJobs = [];

/**
 * Helper to register and register a cron execution block
 * @param {string} cronTime 
 * @param {string} label 
 * @param {Function} taskFn 
 */
function registerCron(cronTime, label, taskFn) {
    try {
        const job = new CronJob(cronTime, async () => {
            logger.info(`Scheduled execution triggered: "${label}"`, { action: "scheduler_trigger" });
            try {
                await taskFn();
            } catch (err) {
                logger.error(`Scheduler runtime error in "${label}": ${err.message}`, { success: false });
            }
        }, null, true, "Asia/Kolkata"); // Standard localized timezone matching current portal activity time
        
        scheduledJobs.push({ label, cronTime, job });
        logger.info(`Registered cron task: "${label}" -> [${cronTime}]`);
    } catch (e) {
        logger.error(`Could not register schedule for "${label}": ${e.message}`);
    }
}

// 1. Naukri Profile Updates schedule
if (config.portals.naukri.scheduleUpdate) {
    registerCron(
        config.portals.naukri.scheduleUpdate,
        "Naukri Profile Update",
        async () => {
            await runJob("naukri", "updateProfile");
        }
    );
}

// 2. Naukri Apply Jobs schedule
if (config.portals.naukri.scheduleApply) {
    registerCron(
        config.portals.naukri.scheduleApply,
        "Naukri Job Applications",
        async () => {
            await runJob("naukri", "apply", { keywords: "Software Engineer", location: "Bangalore" });
        }
    );
}

// 3. LinkedIn Apply Jobs schedule
if (config.portals.linkedin.scheduleApply) {
    registerCron(
        config.portals.linkedin.scheduleApply,
        "LinkedIn Job Applications",
        async () => {
            await runJob("linkedin", "apply", { keywords: "Software Engineer" });
        }
    );
}

// Send start signal alert to admin
telegramService.sendMessage(
    `⚙️ *Platform Scheduler Initialized*\n` +
    `Monitoring *${scheduledJobs.length}* active cron patterns.`
);

// Graceful shutdown behavior
process.on("SIGTERM", () => {
    logger.info("Gracefully shutting down scheduler thread...");
    for (const task of scheduledJobs) {
        task.job.stop();
    }
    process.exit(0);
});
