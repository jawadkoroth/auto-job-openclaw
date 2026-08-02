/**
 * Empirical Verification Suite — Phase Y Telegram Conversation Engine v2
 * Tests: 3 Operating Modes, WAITING_FOR_INPUT interception, Worker Selection, and Explicit /ai Activation.
 */

const assert = require("assert");
const commandParser = require("../apps/telegram/CommandParser");
const telegramService = require("../apps/telegram");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const aiService = require("../packages/ai");
const db = require("../packages/database");

async function runEmpiricalValidation() {
    console.log("=================================================");
    console.log(" Phase Y Telegram Engine v2 Empirical Test Suite ");
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

    // --- 1. Mode 1 (Automation Mode): Reply "B" or "30 days" to an active questionnaire ---
    await testAsync("Mode 1: Reply 'B' to active questionnaire reaches automation only (NO AI)", async () => {
        const testJobId = "test-phase-y-job-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["cutshort", testJobId, "TechCorp", "DevOps Engineer", "Expected CTC? A) 18 LPA B) 20 LPA C) Other"]
        );

        let sentMsg = "";
        let openRouterCalled = false;

        const origSendMessage = telegramService.sendMessage;
        const origChatCompletion = aiService.chatCompletion;

        telegramService.sendMessage = async (text) => { sentMsg = text; };
        aiService.chatCompletion = async () => { openRouterCalled = true; return "AI response"; };

        // User sends "B"
        await telegramService.handleCommand({ text: "B", from: { id: 123 } });

        // Restore
        telegramService.sendMessage = origSendMessage;
        aiService.chatCompletion = origChatCompletion;

        assert.strictEqual(openRouterCalled, false, "OpenRouter must NEVER be called when task is in WAITING_FOR_INPUT");
        assert.ok(sentMsg.includes("Answer Forwarded to Automation"), "Must confirm answer recorded for automation");
        assert.ok(sentMsg.includes("<code>B</code>"), "Must display recorded answer 'B'");

        const updatedJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [testJobId]);
        assert.strictEqual(updatedJob.status, "READY_TO_RESUME", "Job status must update to READY_TO_RESUME");
        assert.strictEqual(updatedJob.pending_suggested_answer, "B", "Saved answer must be 'B'");
    });

    await testAsync("Mode 1: Reply '30 days' updates waiting automation", async () => {
        const testJobId = "test-phase-y-job-2-" + Date.now();
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status, pending_question) VALUES (?, ?, ?, ?, 'WAITING_FOR_INPUT', ?)",
            ["naukri", testJobId, "GlobalInc", "Cloud Architect", "Notice Period?"]
        );

        let sentMsg = "";
        let openRouterCalled = false;

        const origSendMessage = telegramService.sendMessage;
        const origChatCompletion = aiService.chatCompletion;

        telegramService.sendMessage = async (text) => { sentMsg = text; };
        aiService.chatCompletion = async () => { openRouterCalled = true; return "AI response"; };

        await telegramService.handleCommand({ text: "30 days", from: { id: 123 } });

        telegramService.sendMessage = origSendMessage;
        aiService.chatCompletion = origChatCompletion;

        assert.strictEqual(openRouterCalled, false, "OpenRouter must NEVER be called in Automation Mode");
        assert.ok(sentMsg.includes("Answer Forwarded to Automation"), "Must record answer for automation");

        const updatedJob = await db.get("SELECT * FROM jobs WHERE job_id = ?", [testJobId]);
        assert.strictEqual(updatedJob.status, "READY_TO_RESUME");
        assert.strictEqual(updatedJob.pending_suggested_answer, "30 days");
    });

    // Cleanup active WAITING_FOR_INPUT rows to prepare for Mode 2 & Mode 3 tests
    await db.run("UPDATE jobs SET status = 'COMPLETED' WHERE status = 'WAITING_FOR_INPUT'");

    // --- 2. Worker Selection Verification ---
    test("Worker Selection: 'start naukri' defaults to Windows Worker", () => {
        const parsed = commandParser.parse("start naukri");
        assert.strictEqual(parsed.intent, "START");
        assert.strictEqual(parsed.portal, "naukri");
        
        const worker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(worker.id, "windows", "'start naukri' must select Windows Worker");
    });

    test("Worker Selection: 'start naukri mobile' selects Android Worker", () => {
        const parsed = commandParser.parse("start naukri mobile");
        assert.strictEqual(parsed.intent, "START");
        assert.strictEqual(parsed.portal, "naukri");
        assert.strictEqual(parsed.targetWorker, "android");

        const worker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(worker.id, "android", "'start naukri mobile' must select Android Worker");
    });

    test("Worker Selection: 'start naukri oracle' selects Oracle Worker", () => {
        const parsed = commandParser.parse("start naukri oracle");
        assert.strictEqual(parsed.intent, "START");
        assert.strictEqual(parsed.portal, "naukri");
        assert.strictEqual(parsed.targetWorker, "oracle");

        const worker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(worker.id, "oracle", "'start naukri oracle' must select Oracle Worker");
    });

    test("Worker Selection: 'refresh naukri profile' defaults to Windows Worker", () => {
        const parsed = commandParser.parse("refresh naukri profile");
        assert.strictEqual(parsed.intent, "REFRESH_PROFILE");
        assert.strictEqual(parsed.portal, "naukri");

        const worker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
        assert.strictEqual(worker.id, "windows", "'refresh naukri profile' must select Windows Worker");
    });

    // --- 3. Mode 3 (AI Mode): Explicit /ai activation ---
    test("Mode 3: '/ai explain docker' parses explicit AI intent", () => {
        const parsed = commandParser.parse("/ai explain docker");
        assert.strictEqual(parsed.intent, "AI");
        assert.strictEqual(parsed.prompt, "explain docker");
        assert.strictEqual(parsed.isDeterministicCommand, true);
    });

    // --- 4. Mode 2 (Command Mode): Unprefixed conversational text does NOT call OpenRouter ---
    await testAsync("Mode 2: Unprefixed 'explain docker' when no task waiting does NOT call OpenRouter", async () => {
        let sentMsg = "";
        let openRouterCalled = false;

        const origSendMessage = telegramService.sendMessage;
        const origChatCompletion = aiService.chatCompletion;

        telegramService.sendMessage = async (text) => { sentMsg = text; };
        aiService.chatCompletion = async () => { openRouterCalled = true; return "AI response"; };

        await telegramService.handleCommand({ text: "explain docker", from: { id: 123 } });

        telegramService.sendMessage = origSendMessage;
        aiService.chatCompletion = origChatCompletion;

        assert.strictEqual(openRouterCalled, false, "OpenRouter must NEVER be called without /ai prefix");
        assert.ok(sentMsg.includes("Unrecognized Command"), "Should prompt user with command guidance");
        assert.ok(sentMsg.includes("<code>/ai</code>"), "Should instruct user to use /ai prefix");
    });

    // --- 5. System Commands & Help ---
    test("Help Command: 'help' parses HELP intent", () => {
        const parsed = commandParser.parse("help");
        assert.strictEqual(parsed.intent, "HELP");
        assert.strictEqual(parsed.isDeterministicCommand, true);
    });

    await testAsync("Help Command: 'help' displays available commands & worker selection", async () => {
        let helpOutput = "";
        const origSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => { helpOutput = text; };

        await telegramService.handleCommand({ text: "help", from: { id: 123 } });
        telegramService.sendMessage = origSendMessage;

        assert.ok(helpOutput.includes("start naukri"), "Help must display start naukri");
        assert.ok(helpOutput.includes("start naukri pc"), "Help must display start naukri pc");
        assert.ok(helpOutput.includes("start naukri mobile"), "Help must display start naukri mobile");
        assert.ok(helpOutput.includes("start naukri oracle"), "Help must display start naukri oracle");
        assert.ok(helpOutput.includes("/ai &lt;question&gt;"), "Help must display /ai instructions");
    });

    console.log("\n=================================================");
    console.log(` Empirical Verification Completed: ${passedTests}/${totalTests} Tests Passed`);
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
