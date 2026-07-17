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
            let isSessionHealthy = false;
            try {
                isSessionHealthy = await plugin.health(page);
            } catch (healthErr) {
                logger.worker.warn(`Session health check failed: ${healthErr.message}`);
            }
            if (!isSessionHealthy) {
                logger.worker.warn(`Session for ${portal} expired or invalid. Running re-login...`);
                try {
                    const loginSuccess = await plugin.login(page);
                    if (!loginSuccess) {
                        const contextManager = require("../../packages/browser/ContextManager");
                        await contextManager.updateMetadata(portal, { sessionHealth: "auth_required" });
                        throw new Error(`AUTH_REQUIRED: Failed to restore session login for ${portal}. Credentials may be invalid or session has expired.`);
                    }
                } catch (loginErr) {
                    const contextManager = require("../../packages/browser/ContextManager");
                    await contextManager.updateMetadata(portal, { sessionHealth: "auth_required" });
                    throw new Error(`AUTH_REQUIRED: Login crashed or failed for ${portal}: ${loginErr.message}`);
                }
            }
        }

        // 3. Execute business logic action
        switch (action) {
            case "login": {
                try {
                    const loginOk = await plugin.login(page);
                    if (loginOk) {
                        const contextManager = require("../../packages/browser/ContextManager");
                        await contextManager.updateMetadata(portal, { sessionHealth: "healthy" });
                        eventBus.emit("LoginSucceeded", { portal, taskId: task.id });
                        result = { success: true };
                    } else {
                        const contextManager = require("../../packages/browser/ContextManager");
                        await contextManager.updateMetadata(portal, { sessionHealth: "auth_required" });
                        eventBus.emit("LoginFailed", { portal, taskId: task.id });
                        throw new Error("AUTH_REQUIRED: Plugin login failed verification.");
                    }
                } catch (loginErr) {
                    const contextManager = require("../../packages/browser/ContextManager");
                    await contextManager.updateMetadata(portal, { sessionHealth: "auth_required" });
                    eventBus.emit("LoginFailed", { portal, taskId: task.id });
                    throw new Error(`AUTH_REQUIRED: Login crashed: ${loginErr.message}`);
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
                const maxPortalLimit = parseInt(process.env.MAX_APPLICATIONS_PER_PORTAL || "5", 10);
                const maxRunLimit = parseInt(process.env.MAX_APPLICATIONS_PER_RUN || "20", 10);
                
                // Track daily portal application counts
                const todayPortalApplied = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND (applied = 1 OR status = 'APPLIED') AND date(timestamp) = date('now')",
                    [portal]
                );
                const portalCount = todayPortalApplied ? todayPortalApplied.count : 0;
                
                const todayTotalApplied = await db.get(
                    "SELECT COUNT(*) as count FROM jobs WHERE (applied = 1 OR status = 'APPLIED') AND date(timestamp) = date('now')"
                );
                const totalCount = todayTotalApplied ? todayTotalApplied.count : 0;
                
                if (portalCount >= maxPortalLimit) {
                    logger.worker.info(`Daily application limit reached for ${portal} (${portalCount}/${maxPortalLimit}). Skipping remaining applications.`);
                    result = { appliedCount: 0 };
                    break;
                }
                
                if (totalCount >= maxRunLimit) {
                    logger.worker.info(`Daily run application limit reached (${totalCount}/${maxRunLimit}). Skipping remaining applications.`);
                    result = { appliedCount: 0 };
                    break;
                }

                // Query eligible jobs
                const limit = Math.min(task.args.limit || 5, maxPortalLimit - portalCount);
                const jobsToApply = await db.all(
                    `SELECT * FROM jobs 
                     WHERE portal = ? 
                       AND applied = 0 
                       AND ignored = 0 
                       AND (status IS NULL OR status IN ('DISCOVERED', 'ELIGIBLE', 'FAILED', 'EXTERNAL_PENDING'))
                     LIMIT ?`,
                    [portal, limit]
                );
                
                logger.worker.info(`Found ${jobsToApply.length} eligible jobs to process on ${portal}`);
                let appliedCount = 0;
                
                const resumeSelector = require("../../packages/resume/ResumeSelector");
                const externalApplicationRouter = require("../../packages/router/ExternalApplicationRouter");

                for (let i = 0; i < jobsToApply.length; i++) {
                    const job = jobsToApply[i];
                    
                    // Double check limit dynamically inside loop
                    const currentPortalCount = (await db.get(
                        "SELECT COUNT(*) as count FROM jobs WHERE portal = ? AND (applied = 1 OR status = 'APPLIED') AND date(timestamp) = date('now')",
                        [portal]
                    )).count;
                    const currentTotalCount = (await db.get(
                        "SELECT COUNT(*) as count FROM jobs WHERE (applied = 1 OR status = 'APPLIED') AND date(timestamp) = date('now')"
                    )).count;
                    
                    if (currentPortalCount >= maxPortalLimit) {
                        logger.worker.info(`Portal daily application limit of ${maxPortalLimit} hit dynamically in loop. Skipping.`);
                        break;
                    }
                    if (currentTotalCount >= maxRunLimit) {
                        logger.worker.info(`Run daily application limit of ${maxRunLimit} hit dynamically in loop. Skipping.`);
                        break;
                    }
                    
                    // Duplicate check (portal, job_id, url)
                    const alreadyApplied = await db.get(
                        `SELECT id FROM jobs 
                         WHERE ((portal = ? AND job_id = ?) OR (url = ? AND url IS NOT NULL AND url != ''))
                           AND (applied = 1 OR status IN ('APPLIED', 'ALREADY_APPLIED'))`,
                        [portal, job.job_id, job.url]
                    );
                    if (alreadyApplied) {
                        logger.worker.info(`Skipping duplicate job: "${job.title}" at "${job.company}".`);
                        await db.run("UPDATE jobs SET status = 'ALREADY_APPLIED', ignored = 1, reason = 'Already applied' WHERE id = ?", [job.id]);
                        continue;
                    }

                    // Randomized delay before executing the apply action (except first)
                    if (i > 0) {
                        const minD = parseInt(process.env.MIN_DELAY_BETWEEN_APPLICATIONS_SECONDS || "20", 10);
                        const maxD = parseInt(process.env.MAX_DELAY_BETWEEN_APPLICATIONS_SECONDS || "60", 10);
                        const delaySec = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
                        logger.worker.info(`Waiting for ${delaySec} seconds before the next application...`);
                        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
                    }
                    
                    try {
                        // Mark state as APPLYING
                        await db.run("UPDATE jobs SET status = 'APPLYING' WHERE id = ?", [job.id]);
                        
                        // Select resume variant
                        const resumeType = resumeSelector.selectResume(job.title, job.job_description || "");
                        job.resumeType = resumeType;
                        
                        let applyOk = false;
                        if (job.status === "EXTERNAL_PENDING") {
                            const externalAtsAutomation = require("../../packages/automation/ExternalAtsAutomation");
                            applyOk = await externalAtsAutomation.apply(page, job);
                        } else {
                            applyOk = await plugin.apply(page, job);
                        }
                        const statusReason = job.statusReason || "";
                        
                        if (applyOk) {
                            if (statusReason === "dry_run_validated") {
                                logger.worker.info(`[browser-worker] [DRY RUN] Validation pass successful for job id: ${job.id} (Skipping DB write)`);
                            } else if (statusReason === "alreadyApplied") {
                                await db.run(
                                    "UPDATE jobs SET applied = 1, status = 'ALREADY_APPLIED', reason = 'Already applied', timestamp = CURRENT_TIMESTAMP WHERE id = ?",
                                    [job.id]
                                );
                            } else if (statusReason === "clicked_unverified") {
                                await db.run(
                                    "UPDATE jobs SET applied = 1, status = 'CLICKED_UNVERIFIED', reason = 'Clicked but unverified', timestamp = CURRENT_TIMESTAMP WHERE id = ?",
                                    [job.id]
                                );
                            } else {
                                await db.run(
                                    "UPDATE jobs SET applied = 1, status = 'APPLIED', reason = 'Successfully applied', timestamp = CURRENT_TIMESTAMP WHERE id = ?",
                                    [job.id]
                                );
                            }
                            appliedCount++;
                            eventBus.emit("JobApplied", { portal, job });
                        } else {
                            if (statusReason === "questionnaire") {
                                await db.run(
                                    "UPDATE jobs SET status = 'WAITING_FOR_INPUT', reason = 'Questionnaire' WHERE id = ?",
                                    [job.id]
                                );
                            } else if (statusReason === "external") {
                                let extUrl = job.externalUrl || job.url;
                                const ats = await externalApplicationRouter.route(job, extUrl);
                                logger.worker.info(`Job ${job.job_id} routed to external ATS queue: ${ats}`);
                            } else {
                                await db.run(
                                    "UPDATE jobs SET status = 'FAILED', reason = 'Selector action failed' WHERE id = ?",
                                    [job.id]
                                );
                            }
                        }
                    } catch (applyErr) {
                        logger.worker.error(`Application crash for job ${job.job_id}: ${applyErr.message}`);
                        await db.run("UPDATE jobs SET status = 'FAILED', reason = ? WHERE id = ?", [applyErr.message, job.id]);
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
