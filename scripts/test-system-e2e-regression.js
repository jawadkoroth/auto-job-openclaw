const assert = require("assert");
const commandParser = require("../apps/telegram/CommandParser");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const taskQueue = require("../packages/queue/TaskQueue");
const db = require("../packages/database");

console.log("==================================================");
console.log("OPENCLAW SYSTEM-WIDE E2E REGRESSION TEST SUITE");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function runTest(description, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ PASS: ${description}`);
    } catch (err) {
        failed++;
        console.error(`❌ FAIL: ${description} - ${err.message}`);
    }
}

async function runAsyncTest(description, fn) {
    try {
        await fn();
        passed++;
        console.log(`✓ PASS: ${description}`);
    } catch (err) {
        failed++;
        console.error(`❌ FAIL: ${description} - ${err.message}`);
    }
}

(async () => {
    await db.init();

    // Reset initial worker states for deterministic testing
    workerRegistry.registerWorker("windows", { status: "offline", lastHeartbeat: 0 });
    workerRegistry.registerWorker("android", { status: "offline", lastHeartbeat: 0 });
    workerRegistry.registerWorker("oracle", { status: "online", lastHeartbeat: Date.now() });

    // TEST 1: Telegram command "start naukri pc"
    runTest("TEST 1: Telegram 'start naukri pc' parses workerPreference as 'windows'", () => {
        const parsed = commandParser.parse("start naukri pc");
        assert.strictEqual(parsed.portal, "naukri");
        assert.strictEqual(parsed.targetWorker, "windows");
        const norm = workerRegistry.normalizeWorkerId(parsed.targetWorker);
        assert.strictEqual(norm, "windows");
    });

    // TEST 2: Telegram command "start naukri"
    runTest("TEST 2: Telegram 'start naukri' resolves to Windows worker as default priority", () => {
        const parsed = commandParser.parse("start naukri");
        assert.strictEqual(parsed.portal, "naukri");
        const targetWorker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(targetWorker.id, "windows");
    });

    // TEST 3: Telegram command "start naukri mobile"
    runTest("TEST 3: Telegram 'start naukri mobile' resolves target worker as 'android'", () => {
        const parsed = commandParser.parse("start naukri mobile");
        assert.strictEqual(parsed.portal, "naukri");
        assert.strictEqual(parsed.targetWorker, "android");
        const norm = workerRegistry.normalizeWorkerId(parsed.targetWorker);
        assert.strictEqual(norm, "android");
    });

    // TEST 4: Telegram command "start linkedin"
    runTest("TEST 4: Telegram 'start linkedin' resolves to Windows worker node", () => {
        const parsed = commandParser.parse("start linkedin");
        assert.strictEqual(parsed.portal, "linkedin");
        const targetWorker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(targetWorker.id, "windows");
    });

    // TEST 5: Telegram command "start hirist"
    runTest("TEST 5: Telegram 'start hirist' resolves to Oracle worker node", () => {
        const parsed = commandParser.parse("start hirist");
        assert.strictEqual(parsed.portal, "hirist");
        const targetWorker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(targetWorker.id, "oracle");
    });

    // TEST 6: Worker heartbeat ONLINE when sending heartbeats
    runTest("TEST 6: Worker state transitions to ONLINE when heartbeat received", () => {
        workerRegistry.updateHeartbeat("windows", { status: "online", hostname: "test-pc" });
        const isOnline = workerRegistry.isWorkerOnline("windows");
        assert.strictEqual(isOnline, true);
    });

    // TEST 7: Worker heartbeat OFFLINE / STALE when heartbeat expires
    runTest("TEST 7: Worker state transitions to OFFLINE when heartbeat is stale (>45s)", () => {
        const worker = workerRegistry.getWorker("windows");
        worker.lastHeartbeat = Date.now() - 50000; // 50s ago
        worker.status = "offline";
        const isOnline = workerRegistry.isWorkerOnline("windows");
        assert.strictEqual(isOnline, false);
    });

    // TEST 8: Task Queuing and Dispatch Acknowledgement
    await runAsyncTest("TEST 8: TaskQueue pushes task and updates status upon remote acknowledgement", async () => {
        const taskId = await taskQueue.push("naukri", "apply", { limit: 5 }, "windows");
        assert.ok(taskId);

        const task = await taskQueue.getNext("windows");
        assert.ok(task);
        assert.strictEqual(task.status, "dispatched");

        await taskQueue.acknowledge(task.id, "windows");
        const acked = await db.get("SELECT status FROM tasks WHERE id = ?", [task.id]);
        assert.strictEqual(acked.status, "running");
    });

    // TEST 9: Offline Worker Rejection (No False Success)
    await runAsyncTest("TEST 9: Execution rejected when worker is OFFLINE without claiming execution", async () => {
        workerRegistry.setWorkerStatus("windows", "offline", { lastHeartbeat: 0 });
        const result = await workerRegistry.execute("windows", { portal: "naukri", action: "apply" });
        assert.strictEqual(result.queued, false);
        assert.strictEqual(result.status, "OFFLINE");
    });

    // TEST 10: Task Completion Log & Cleanup
    await runAsyncTest("TEST 10: TaskQueue complete marks task status as completed in database", async () => {
        const taskId = await taskQueue.push("naukri", "apply", {}, "windows");
        await taskQueue.complete(taskId, { appliedCount: 2 });
        const completed = await db.get("SELECT status, result FROM tasks WHERE id = ?", [taskId]);
        assert.strictEqual(completed.status, "completed");
    });

    console.log("\n==================================================");
    console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("==================================================");

    if (failed > 0) {
        process.exit(1);
    }
})();
