const assert = require("assert");
const telegramService = require("../apps/telegram");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const taskQueue = require("../packages/queue/TaskQueue");
const db = require("../packages/database");

async function testWindowsWorkerLiveDispatch() {
    console.log("=================================================");
    console.log(" Testing Windows Worker Live Task Dispatch Flow ");
    console.log("=================================================\n");

    await db.init();

    // 1. Simulate Windows worker heartbeat
    workerRegistry.updateHeartbeat("windows", {
        status: "online",
        hostname: "windows-laptop",
        platform: "win32",
        lastHeartbeat: Date.now()
    });

    let sentTelegramMessages = [];
    const origSend = telegramService.sendMessage;
    telegramService.sendMessage = async (msg) => {
        sentTelegramMessages.push(msg);
        console.log(`[Telegram Bot Response]:\n${msg}\n`);
    };

    // 2. Dispatch "start naukri pc"
    console.log("--- Sending Telegram Command: 'start naukri pc' ---");
    await telegramService.handleCommand({ text: "start naukri pc", from: { id: 123 } });

    assert.ok(sentTelegramMessages.some(m => m.includes("NAUKRI Job Automation Queued")), "Must queue Naukri");
    assert.ok(sentTelegramMessages.some(m => m.includes("WAITING_FOR_WORKER")), "Status must be WAITING_FOR_WORKER");

    // 3. Windows Agent Poll
    const naukriTask = await taskQueue.getNext("windows");
    assert.ok(naukriTask !== null, "Windows Worker poll must return task != null");
    console.log(`✓ Windows Agent polled task successfully: ID=${naukriTask.id.substring(0, 8)}, Portal=${naukriTask.portal}, Action=${naukriTask.action}`);
    assert.strictEqual(naukriTask.portal, "naukri");

    // 4. Windows Agent Ack
    await taskQueue.acknowledge(naukriTask.id, "windows");
    console.log(`✓ Windows Agent ACKed task #${naukriTask.id.substring(0, 8)}`);

    // Complete task
    await taskQueue.complete(naukriTask.id, { success: true });
    console.log(`✓ Task completed.\n`);

    // 5. Dispatch "start linkedin pc"
    sentTelegramMessages = [];
    console.log("--- Sending Telegram Command: 'start linkedin pc' ---");
    await telegramService.handleCommand({ text: "start linkedin pc", from: { id: 123 } });

    assert.ok(sentTelegramMessages.some(m => m.includes("LINKEDIN Job Automation Queued")), "Must queue LinkedIn");

    const linkedinTask = await taskQueue.getNext("windows");
    assert.ok(linkedinTask !== null, "Windows Worker poll must return LinkedIn task != null");
    console.log(`✓ Windows Agent polled LinkedIn task successfully: ID=${linkedinTask.id.substring(0, 8)}, Portal=${linkedinTask.portal}, Action=${linkedinTask.action}`);
    assert.strictEqual(linkedinTask.portal, "linkedin");

    await taskQueue.acknowledge(linkedinTask.id, "windows");
    console.log(`✓ Windows Agent ACKed LinkedIn task #${linkedinTask.id.substring(0, 8)}`);
    await taskQueue.complete(linkedinTask.id, { success: true });

    telegramService.sendMessage = origSend;

    console.log("\n=================================================");
    console.log(" ✅ All Windows Worker Dispatch Verifications Passed");
    console.log("=================================================\n");
}

testWindowsWorkerLiveDispatch().catch(err => {
    console.error("Windows worker dispatch verification failed:", err);
    process.exit(1);
});
