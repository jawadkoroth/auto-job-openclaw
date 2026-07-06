const taskQueue = require("../packages/queue/TaskQueue");
const { handleTask } = require("../apps/browser-worker");
const db = require("../packages/database");
const eventBus = require("../packages/events/EventBus");
const logger = require("../packages/logger");

(async () => {
    try {
        logger.automation.info("=== Starting Worker Engine Integration verification check ===");
        await db.init();
        
        // Setup EventBus log hook to verify events are triggered
        eventBus.on("BrowserStarted", (data) => {
            logger.automation.info(`[EVENT HOOK] BrowserStarted triggered: ${JSON.stringify(data)}`);
        });
        
        eventBus.on("WorkerFinished", (data) => {
            logger.automation.info(`[EVENT HOOK] WorkerFinished triggered: ${JSON.stringify(data)}`);
        });

        // 1. Push Naukri updateProfile task
        const taskId = await taskQueue.push("naukri", "updateProfile");
        logger.automation.info(`Pushed Naukri task to DB: ${taskId}`);
        
        // 2. Fetch task from SQLite
        const task = await taskQueue.getNext();
        if (task) {
            // 3. Execute job using worker handler
            await handleTask(task);
        } else {
            throw new Error("Could not fetch queued task from SQLite database.");
        }
        
        logger.automation.info("Worker validation run complete. Success.");
        process.exit(0);
    } catch (e) {
        console.error("Worker verification check failed:", e);
        process.exit(1);
    }
})();
