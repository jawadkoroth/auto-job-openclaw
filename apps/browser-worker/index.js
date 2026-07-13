const browserPool = require("../../packages/browser/BrowserPool");
const pluginManager = require("../../packages/plugins/PluginManager");
const taskQueue = require("../../packages/queue/TaskQueue");
const eventBus = require("../../packages/events/EventBus");
const db = require("../../packages/database");
const logger = require("../../packages/logger");

/**
 * Handle a single popped queue task with isolated execution, screenshots, and retries.
 * @param {Object} task 
 */
async function handleTask(task) {
    const portal = task.portal;
    const action = task.action;
    
    logger.worker.info(`Popped task ${task.id} for portal: ${portal}.${action}`);
    
    let browserInstance = null;
    let page = null;
    let result = null;
    
    try {
        // 1. Fetch browser instance from BrowserPool
        browserInstance = await browserPool.getInstance(portal);
        page = await browserInstance.newPage();
        
        eventBus.emit("BrowserStarted", { portal, taskId: task.id });

        // 2. Load dynamic plugin instance
        const plugin = pluginManager.getPlugin(portal);

        // Verify active login session before running updates or applies
        if (action !== "login") {
            logger.worker.info(`Verifying session health status for: ${portal}...`);
            const isSessionHealthy = await plugin.health(page);
            if (!isSessionHealthy) {
                logger.worker.warn(`Session for ${portal} expired or invalid. Running re-login...`);
                const loginSuccess = await plugin.login(page);
                if (!loginSuccess) {
                    throw new Error(`Failed to restore session login for ${portal}.`);
                }
            }
        }

        // 3. Execute business logic action
        switch (action) {
            case "login": {
                const loginOk = await plugin.login(page);
                if (loginOk) {
                    eventBus.emit("LoginSucceeded", { portal, taskId: task.id });
                    result = { success: true };
                } else {
                    eventBus.emit("LoginFailed", { portal, taskId: task.id });
                    throw new Error("Plugin login failed verification.");
                }
                break;
            }
            case "updateProfile": {
                const updateOk = await plugin.updateProfile(page);
                result = { success: updateOk };
                break;
            }
            case "search": {
                // Search jobs, normalize, write to SQLite Job DB (deduplicate)
                const keywords = task.args.keywords || "Software Engineer";
                const location = task.args.location || "";
                
                const jobs = await plugin.search(page, { keywords, location });
                
                let foundCount = 0;
                let dupCount = 0;
                
                for (const job of jobs) {
                    try {
                        const insertSql = `
                            INSERT INTO jobs (portal, job_id, company, title, location, salary, experience, url, applied, ignored)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                        `;
                        await db.run(insertSql, [
                            job.portal, 
                            job.job_id, 
                            job.company, 
                            job.title, 
                            job.location, 
                            job.salary,
                            job.experience,
                            job.url
                        ]);
                        foundCount++;
                        eventBus.emit("JobFound", { portal, job });
                    } catch (dbErr) {
                        // Handle SQLite UNIQUE constraint failures for deduplication
                        if (dbErr.message.includes("UNIQUE constraint failed")) {
                            dupCount++;
                        } else {
                            logger.worker.error(`Failed to insert scraped job ${job.job_id}: ${dbErr.message}`);
                        }
                    }
                }
                logger.worker.info(`Search complete: ${foundCount} new saved, ${dupCount} duplicates skipped.`);
                result = { foundCount, dupCount };
                break;
            }
            case "apply": {
                // Apply to deduplicated database jobs
                const limit = task.args.limit || 5;
                const jobsToApply = await db.all(
                    "SELECT * FROM jobs WHERE portal = ? AND applied = 0 AND ignored = 0 LIMIT ?",
                    [portal, limit]
                );
                
                logger.worker.info(`Found ${jobsToApply.length} deduplicated jobs to process on ${portal}`);
                let appliedCount = 0;
                
                for (const job of jobsToApply) {
                    try {
                        const applyOk = await plugin.apply(page, job);
                        if (applyOk) {
                            await db.run("UPDATE jobs SET applied = 1, timestamp = CURRENT_TIMESTAMP WHERE id = ?", [job.id]);
                            appliedCount++;
                            eventBus.emit("JobApplied", { portal, job });
                        } else {
                            await db.run("UPDATE jobs SET ignored = 1, reason = 'Selector action failed' WHERE id = ?", [job.id]);
                        }
                    } catch (applyErr) {
                        logger.worker.error(`Application crash for job ${job.job_id}: ${applyErr.message}`);
                        await db.run("UPDATE jobs SET ignored = 1, reason = ? WHERE id = ?", [applyErr.message, job.id]);
                    }
                }
                result = { appliedCount };
                break;
            }
            default:
                throw new Error(`Action not supported: ${action}`);
        }

        // Set task state as completed
        await taskQueue.complete(task.id, result);
        eventBus.emit("WorkerFinished", { taskId: task.id, portal, action, success: true, result });
        await logger.logMetric({ type: "task_success", taskId: task.id, portal, action, result });

    } catch (err) {
        logger.worker.error(`Task ${task.id} failed with error: ${err.message}`);
        
        // Attempt failure screenshot
        let screenshotPath = null;
        if (browserInstance && page) {
            try {
                screenshotPath = await browserInstance.takeScreenshot(page, `${portal}_${action}_failed`);
                if (screenshotPath) {
                    eventBus.emit("ScreenshotCaptured", { portal, taskId: task.id, path: screenshotPath });
                }
            } catch (snapErr) {
                logger.worker.error(`Failed to capture exception snapshot: ${snapErr.message}`);
            }
        }

        eventBus.emit("PluginCrashed", { portal, taskId: task.id, action, error: err.message, screenshotPath });
        
        // Mark task failed
        await taskQueue.fail(task.id, err.message);
        eventBus.emit("WorkerFinished", { taskId: task.id, portal, action, success: false, error: err.message });
        await logger.logMetric({ type: "task_failed", taskId: task.id, portal, action, error: err.message });
        
        // Trigger browser instance restart
        if (browserInstance) {
            try {
                await browserInstance.restart();
            } catch (restartErr) {
                logger.worker.error(`Browser recovery restart failed: ${restartErr.message}`);
            }
        }
    }
}

/**
 * Initialize worker polling daemon thread
 */
async function startWorker() {
    logger.worker.info("Browser Worker daemon thread started. Polling SQLite queue...");
    
    const poll = async () => {
        try {
            const task = await taskQueue.getNext();
            if (task) {
                await handleTask(task);
            }
        } catch (e) {
            logger.worker.error(`Exception in worker poll cycle: ${e.message}`);
        }
        setTimeout(poll, 2000);
    };
    
    poll();
}

if (require.main === module) {
    db.init().then(() => {
        startWorker();
    }).catch(err => {
        console.error("Worker failed to connect to database:", err);
    });
}

module.exports = {
    handleTask,
    startWorker
};
