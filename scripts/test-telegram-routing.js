/**
 * Empirical Verification Suite — Telegram Command Routing & OpenRouter Failover
 */

const assert = require("assert");
const commandParser = require("../apps/telegram/CommandParser");
const telegramService = require("../apps/telegram");
const aiService = require("../packages/ai");

async function runEmpiricalValidation() {
    console.log("=================================================");
    console.log("  Telegram Command Routing & Failover Validation");
    console.log("=================================================\n");

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

    // --- REQUIREMENT 1: "start naukri profile refresh" executes locally without AI ---
    test("Requirement 1: 'start naukri profile refresh' parsed deterministically", () => {
        const parsed = commandParser.parse("start naukri profile refresh");
        assert.strictEqual(parsed.isDeterministicCommand, true);
        assert.strictEqual(parsed.intent, "REFRESH_PROFILE");
        assert.strictEqual(parsed.portal, "naukri");
        assert.strictEqual(parsed.action, "updateProfile");
    });

    // --- REQUIREMENT 2: "status" executes locally ---
    test("Requirement 2: 'status' parsed deterministically", () => {
        const parsed = commandParser.parse("status");
        assert.strictEqual(parsed.isDeterministicCommand, true);
        assert.strictEqual(parsed.intent, "STATUS");
    });

    // --- REQUIREMENT 3: "workers" executes locally ---
    test("Requirement 3: 'workers' parsed deterministically", () => {
        const parsed = commandParser.parse("workers");
        assert.strictEqual(parsed.isDeterministicCommand, true);
        assert.strictEqual(parsed.intent, "WORKERS");
    });

    // --- REQUIREMENT 4: "health" executes locally ---
    test("Requirement 4: 'health' parsed deterministically", () => {
        const parsed = commandParser.parse("health");
        assert.strictEqual(parsed.isDeterministicCommand, true);
        assert.strictEqual(parsed.intent, "HEALTH");
    });

    // --- REQUIREMENT 5: Conversational AI questions reach AI Service ---
    test("Requirement 5: 'Explain Docker.' identified as conversational request", () => {
        const parsed = commandParser.parse("Explain Docker.");
        assert.strictEqual(parsed.isDeterministicCommand, false);
        assert.strictEqual(parsed.intent, "CONVERSATION");
    });

    // --- REQUIREMENT 6 & 7: Simulate OpenRouter 402 Error & Verify Automation Commands Operational ---
    await testAsync("Requirement 6 & 7: Automation commands execute locally during OpenRouter 402 outage", async () => {
        // Mock OpenRouter provider throwing 402 error
        const mockOpenRouter402Provider = {
            generateText: async () => {
                const err = new Error("This request requires more credits (HTTP 402)");
                err.response = { status: 402, data: { error: { message: "Credit limit exceeded", code: 402 } } };
                throw err;
            }
        };

        // Temporarily replace providers array with mock failing provider
        const originalProviders = aiService.providers;
        aiService.providers = [mockOpenRouter402Provider];

        // 1. Verify conversational call fails over / throws
        let aiFailed = false;
        try {
            await aiService.chatCompletion("What is Kubernetes?");
        } catch (e) {
            aiFailed = true;
            assert.strictEqual(e.message.includes("ALL_AI_PROVIDERS_FAILED"), true);
        }
        assert.strictEqual(aiFailed, true, "AI call should fail when OpenRouter throws 402");

        // 2. Verify deterministic automation commands are STILL 100% operational locally
        const commands = [
            "start naukri profile refresh",
            "start hirist",
            "status",
            "workers",
            "health",
            "logs",
            "pause",
            "resume",
            "stop"
        ];

        for (const cmd of commands) {
            const parsed = commandParser.parse(cmd);
            assert.strictEqual(parsed.isDeterministicCommand, true, `Command '${cmd}' must be deterministic`);
        }

        // Restore original providers
        aiService.providers = originalProviders;
    });

    // --- REQUIREMENT 8: Verify AI requests fail gracefully with clear message ---
    await testAsync("Requirement 8: AI requests fail gracefully with informative notification", async () => {
        let sentMessageText = "";
        const originalSendMessage = telegramService.sendMessage;
        telegramService.sendMessage = async (text) => {
            sentMessageText = text;
        };

        // Simulate incoming conversational command when AI is failing
        const mockFailingProviders = [{
            generateText: async () => { throw new Error("HTTP 402 Payment Required: Credit limit reached."); }
        }];

        const originalProviders = aiService.providers;
        aiService.providers = mockFailingProviders;

        await telegramService.handleCommand({ text: "Write a cover letter for DevOps", from: { id: 123 } });

        assert.strictEqual(sentMessageText.includes("AI Service Notice"), true);
        assert.strictEqual(sentMessageText.includes("Payment Required"), true);
        assert.strictEqual(sentMessageText.includes("Deterministic automation commands remain 100% operational"), true);

        // Restore originals
        telegramService.sendMessage = originalSendMessage;
        aiService.providers = originalProviders;
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
