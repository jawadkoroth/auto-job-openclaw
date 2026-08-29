/**
 * Empirical Verification & Regression Suite — Telegram Routing Hierarchy
 * 
 * Validates the strict 5-layer hierarchy:
 * 1. Security / Authorization
 * 2. Deterministic System / Automation Commands (ALWAYS first precedence)
 * 3. Active WAITING_FOR_INPUT Question Answer
 * 4. /ai Explicit AI Command
 * 5. Unprefixed Conversational Message
 */

const assert = require("assert");
const commandParser = require("../apps/telegram/CommandParser");
const telegramService = require("../apps/telegram");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const taskQueue = require("../packages/queue/TaskQueue");
const aiService = require("../packages/ai");
const db = require("../packages/database");

async function runEmpiricalValidation() {
    console.log("=================================================");
    console.log(" Telegram Routing & Command Priority Test Suite  ");
    console.log("=================================================\n");

    await db.init();
    let totalTests = 0;
    let passedTests = 0;

    function test(name, fn) {
        totalTests++;
        try {
            fn();
            passedTests++;
            console.log(`  ✅ [PASS] ${name}`);
        } catch (err) {
            console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        }
    }

    async function testAsync(name, fn) {
        totalTests++;
        try {
            await fn();
            passedTests++;
            console.log(`  ✅ [PASS] ${name}`);
        } catch (err) {
            console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        }
    }

    // Ensure database is clean of active WAITING_FOR_INPUT for clean test setups
    await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE status = 'WAITING_FOR_INPUT'");
    await db.run("UPDATE tasks SET status = 'cancelled' WHERE status = 'WAITING_FOR_INPUT'");

    // -------------------------------------------------------------
    // TEST 1: WAITING_FOR_INPUT + "start naukri pc" -> COMMAND
    // -------------------------------------------------------------
    await testAsync("Test 1: WAITING_FOR_INPUT + 'start naukri pc' -> COMMAND takes precedence", async () => {
        const jobId = "test-job-wfi-1-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["naukri", jobId, "Google", "SRE", "Expected Salary?"]
        );

        // Register windows worker as online
        workerRegistry.updateHeartbeat("windows", { status: "online", lastHeartbeat: Date.now() });

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "start naukri pc", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Must NOT be treated as questionnaire answer");
        assert.ok(sentMsg.includes("NAUKRI Job Automation Queued"), "Must queue NAUKRI job");
        assert.ok(sentMsg.includes("Windows Worker"), "Must target Windows Worker");

        // Job in DB must remain WAITING_FOR_INPUT, not marked READY_TO_RESUME by command
        const waitingJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
        assert.strictEqual(waitingJob.status, "WAITING_FOR_INPUT");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 2: WAITING_FOR_INPUT + "start naukri" -> COMMAND
    // -------------------------------------------------------------
    await testAsync("Test 2: WAITING_FOR_INPUT + 'start naukri' -> COMMAND takes precedence", async () => {
        const jobId = "test-job-wfi-2-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["naukri", jobId, "Meta", "DevOps", "Years of Experience?"]
        );

        workerRegistry.updateHeartbeat("windows", { status: "online", lastHeartbeat: Date.now() });

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "start naukri", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Must NOT treat 'start naukri' as answer");
        assert.ok(sentMsg.includes("NAUKRI Job Automation Queued"), "Must queue NAUKRI automation");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 3: WAITING_FOR_INPUT + "start linkedin pc" -> COMMAND
    // -------------------------------------------------------------
    await testAsync("Test 3: WAITING_FOR_INPUT + 'start linkedin pc' -> COMMAND takes precedence", async () => {
        const jobId = "test-job-wfi-3-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["linkedin", jobId, "Amazon", "Cloud Eng", "Notice Period?"]
        );

        workerRegistry.updateHeartbeat("windows", { status: "online", lastHeartbeat: Date.now() });

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "start linkedin pc", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Must NOT treat as answer");
        assert.ok(sentMsg.includes("LINKEDIN Job Automation Queued"), "Must queue LINKEDIN automation");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 4: WAITING_FOR_INPUT + "status" -> COMMAND
    // -------------------------------------------------------------
    await testAsync("Test 4: WAITING_FOR_INPUT + 'status' -> STATUS command executed", async () => {
        const jobId = "test-job-wfi-4-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["hirist", jobId, "Startup", "Fullstack", "Current CTC?"]
        );

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "status", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Must NOT treat 'status' as answer");
        assert.ok(sentMsg.includes("OpenClaw System Status"), "Must return system status");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 5: WAITING_FOR_INPUT + "cancel" -> COMMAND
    // -------------------------------------------------------------
    await testAsync("Test 5: WAITING_FOR_INPUT + 'cancel' -> Safely transitions waiting tasks to CANCELLED", async () => {
        const jobId = "test-job-wfi-5-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["naukri", jobId, "Netflix", "Infra", "Location preference?"]
        );

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "cancel", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Must NOT treat cancel as answer");
        assert.ok(sentMsg.includes("Automation Cancelled"), "Must confirm cancellation to user");

        const checkJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
        assert.strictEqual(checkJob.status, "CANCELLED", "Job status must transition to CANCELLED");
    });

    // -------------------------------------------------------------
    // TEST 6: WAITING_FOR_INPUT + "20 LPA" -> QUESTIONNAIRE ANSWER
    // -------------------------------------------------------------
    await testAsync("Test 6: WAITING_FOR_INPUT + '20 LPA' -> Treated as QUESTIONNAIRE ANSWER", async () => {
        const jobId = "test-job-wfi-6-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["cutshort", jobId, "Uber", "Senior SRE", "Expected CTC?"]
        );

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "20 LPA", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(sentMsg.includes("Answer Forwarded to Automation"), "Must forward answer to automation");
        assert.ok(sentMsg.includes("<code>20 LPA</code>"), "Must confirm recorded answer");

        const updatedJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
        assert.strictEqual(updatedJob.status, "READY_TO_RESUME", "Job must transition to READY_TO_RESUME");
        assert.strictEqual(updatedJob.pending_suggested_answer, "20 LPA");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 7: WAITING_FOR_INPUT + "B" -> QUESTIONNAIRE ANSWER
    // -------------------------------------------------------------
    await testAsync("Test 7: WAITING_FOR_INPUT + 'B' -> Treated as QUESTIONNAIRE ANSWER", async () => {
        const jobId = "test-job-wfi-7-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["cutshort", jobId, "Swiggy", "DevOps Engineer", "Notice Period? A) Immediate B) 15 Days C) 30 Days"]
        );

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "B", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(sentMsg.includes("Answer Forwarded to Automation"), "Must forward answer to automation");
        assert.ok(sentMsg.includes("<code>B</code>"), "Must display recorded answer 'B'");

        const updatedJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
        assert.strictEqual(updatedJob.status, "READY_TO_RESUME");
        assert.strictEqual(updatedJob.pending_suggested_answer, "B");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id = ?", [jobId]);
    });

    // -------------------------------------------------------------
    // TEST 8: No WAITING_FOR_INPUT + "/ai explain docker" -> AI
    // -------------------------------------------------------------
    await testAsync("Test 8: No WAITING_FOR_INPUT + '/ai explain docker' -> Triggers AI completion", async () => {
        let sentMsg = "";
        let promptSentToAi = "";
        const origSendMessage = telegramService.sendMessage;
        const origChatCompletion = aiService.chatCompletion;

        telegramService.sendMessage = async (text) => { sentMsg = text; };
        aiService.chatCompletion = async (p) => { promptSentToAi = p; return "Docker is a containerization platform."; };

        await telegramService.handleCommand({ text: "/ai explain docker", from: { id: 123 } });

        telegramService.sendMessage = origSendMessage;
        aiService.chatCompletion = origChatCompletion;

        assert.strictEqual(promptSentToAi, "explain docker");
        assert.ok(sentMsg.includes("OpenClaw AI Assistant"));
        assert.ok(sentMsg.includes("Docker is a containerization platform"));
    });

    // -------------------------------------------------------------
    // TEST 9: No WAITING_FOR_INPUT + "explain docker" -> /ai guidance
    // -------------------------------------------------------------
    await testAsync("Test 9: No WAITING_FOR_INPUT + 'explain docker' -> Unrecognized command with /ai guidance", async () => {
        let sentMsg = "";
        let aiCalled = false;
        const origSendMessage = telegramService.sendMessage;
        const origChatCompletion = aiService.chatCompletion;

        telegramService.sendMessage = async (text) => { sentMsg = text; };
        aiService.chatCompletion = async () => { aiCalled = true; return "AI"; };

        await telegramService.handleCommand({ text: "explain docker", from: { id: 123 } });

        telegramService.sendMessage = origSendMessage;
        aiService.chatCompletion = origChatCompletion;

        assert.strictEqual(aiCalled, false, "AI must NEVER be called without /ai prefix");
        assert.ok(sentMsg.includes("Unrecognized Command"));
        assert.ok(sentMsg.includes("<code>/ai</code>"));
    });

    // -------------------------------------------------------------
    // TEST 10: Windows offline + "start naukri pc" -> WORKER_UNAVAILABLE
    // -------------------------------------------------------------
    await testAsync("Test 10: Windows offline + 'start naukri pc' -> Worker Unavailable notice", async () => {
        // Force windows worker offline
        const winWorker = workerRegistry.getWorker("windows");
        if (winWorker) {
            winWorker.status = "offline";
            winWorker.lastHeartbeat = 0;
        }

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "start naukri pc", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(sentMsg.includes("Worker Unavailable"), "Must respond with Worker Unavailable");
        assert.ok(sentMsg.includes("OFFLINE / STALE"), "Must display OFFLINE / STALE");
    });

    // -------------------------------------------------------------
    // TEST 11: Windows online + "start naukri pc" -> Task Queued & Dispatched
    // -------------------------------------------------------------
    await testAsync("Test 11: Windows online + 'start naukri pc' -> Task Queued for Windows Worker", async () => {
        workerRegistry.updateHeartbeat("windows", { status: "online", lastHeartbeat: Date.now() });

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "start naukri pc", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(sentMsg.includes("NAUKRI Job Automation Queued"));
        assert.ok(sentMsg.includes("WAITING_FOR_WORKER"));

        // Verify task exists in queue for windows
        const nextTask = await taskQueue.getNext("windows");
        assert.ok(nextTask !== null, "Task must be present in queue for Windows polling");
        assert.strictEqual(nextTask.portal, "naukri");
        assert.strictEqual(nextTask.status, "dispatched");

        // Clean up task
        await taskQueue.complete(nextTask.id, { success: true });
    });

    // -------------------------------------------------------------
    // TEST 12: Multiple pending questionnaire jobs -> Command still takes precedence
    // -------------------------------------------------------------
    await testAsync("Test 12: Multiple pending questionnaire jobs -> Command still takes precedence", async () => {
        const j1 = "multi-q-1-" + Date.now();
        const j2 = "multi-q-2-" + Date.now();
        await db.run("INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)", ["naukri", j1, "A", "Dev", "Q1"]);
        await db.run("INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)", ["linkedin", j2, "B", "SRE", "Q2"]);

        workerRegistry.updateHeartbeat("windows", { status: "online", lastHeartbeat: Date.now() });

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "workers", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(!sentMsg.includes("Answer Forwarded to Automation"), "Command 'workers' must NOT be consumed as questionnaire answer");
        assert.ok(sentMsg.includes("OpenClaw Execution Worker Nodes"), "Must return workers list");

        await db.run("UPDATE jobs SET status = 'CANCELLED' WHERE job_id IN (?, ?)", [j1, j2]);
    });

    // -------------------------------------------------------------
    // TEST 13: "cancel all pending" -> Safely cancels stale/waiting tasks
    // -------------------------------------------------------------
    await testAsync("Test 13: 'cancel all pending' -> Safely cancels waiting tasks and pending queue", async () => {
        const j1 = "cancel-test-1-" + Date.now();
        const j2 = "cancel-test-2-" + Date.now();
        await db.run("INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)", ["hirist", j1, "CompA", "SE", "Q1"]);
        await db.run("INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)", ["cutshort", j2, "CompB", "DevOps", "Q2"]);
        await taskQueue.push("hirist", "apply", {}, "oracle");

        let sentMsg = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { sentMsg = text; };

        await telegramService.handleCommand({ text: "cancel all pending", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(sentMsg.includes("Automation Cancelled"));
        assert.ok(sentMsg.includes("All Pending Automation"));

        const check1 = await db.get("SELECT * FROM jobs WHERE job_id = ?", [j1]);
        const check2 = await db.get("SELECT * FROM jobs WHERE job_id = ?", [j2]);
        assert.strictEqual(check1.status, "CANCELLED");
        assert.strictEqual(check2.status, "CANCELLED");

        const pendingCount = await taskQueue.getPendingCount();
        assert.strictEqual(pendingCount, 0, "Pending task queue count must be 0 after cancel all");
    });

    console.log("\n=================================================");
    console.log(` Regression Suite Completed: ${passedTests}/${totalTests} Tests Passed`);
    console.log("=================================================\n");

    if (passedTests === totalTests) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runEmpiricalValidation().catch(err => {
    console.error("Verification suite failed:", err);
    process.exit(1);
});
