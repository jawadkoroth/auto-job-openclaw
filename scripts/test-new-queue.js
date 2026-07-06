const taskQueue = require("../packages/queue/TaskQueue");
const db = require("../packages/database");

(async () => {
    try {
        console.log("=== Starting Task Queue verification check ===");
        await db.init();
        
        // 1. Push a test task
        const taskId = await taskQueue.push("naukri", "updateProfile", { forceMode: true });
        console.log(`Task successfully pushed to DB. Task ID: ${taskId}`);
        
        const count = await taskQueue.getPendingCount();
        console.log(`Current pending queue size: ${count}`);
        
        // 2. Fetch and reserve task
        const task = await taskQueue.getNext();
        console.log("Reserved task object popped from DB:", task);
        
        // 3. Mark task completed
        await taskQueue.complete(task.id, { message: "Task executed successfully by virtual runner" });
        console.log("Task marked completed in database.");
        
        // 4. Fetch list of recent actions
        const list = await taskQueue.getRecent(3);
        console.log("Recent task logs retrieved from DB:", JSON.stringify(list, null, 2));
        
        process.exit(0);
    } catch (e) {
        console.error("Task Queue validation failed:", e);
        process.exit(1);
    }
})();
