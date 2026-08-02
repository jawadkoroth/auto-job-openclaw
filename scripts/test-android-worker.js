/**
 * Phase 8 - OpenClaw Android Worker Empirical Validation Test Suite
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");

async function runEmpiricalValidation() {
    console.log("=================================================");
    console.log("  OpenClaw Phase X: Android Worker Empirical Validation");
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

    // --- TEST SUITE 1: Encrypted Storage ---
    console.log("\n--- 1. Security & Encrypted Storage (AES-256-GCM) ---");
    const encryptedStorage = require("../packages/auth/EncryptedStorage");
    
    test("Encrypt & Decrypt Auth Session Tokens", () => {
        const sessionData = { cookies: [{ name: "Naukri_Auth", value: "secret_token_123" }] };
        encryptedStorage.set("test_portal", sessionData);
        const restored = encryptedStorage.get("test_portal");
        assert.deepStrictEqual(restored, sessionData);
        encryptedStorage.delete("test_portal");
    });

    // --- TEST SUITE 2: Command Parser (Natural Language) ---
    console.log("\n--- 2. Natural Language Command Parser ---");
    const commandParser = require("../apps/telegram/CommandParser");

    test("Parse 'start naukri' command", () => {
        const res = commandParser.parse("start naukri");
        assert.strictEqual(res.intent, "START");
        assert.strictEqual(res.portal, "naukri");
    });

    test("Parse 'refresh naukri profile' command", () => {
        const res = commandParser.parse("refresh naukri profile");
        assert.strictEqual(res.intent, "REFRESH_PROFILE");
        assert.strictEqual(res.portal, "naukri");
        assert.strictEqual(res.action, "updateProfile");
    });

    test("Parse 'stop naukri' command", () => {
        const res = commandParser.parse("stop naukri");
        assert.strictEqual(res.intent, "STOP");
        assert.strictEqual(res.portal, "naukri");
    });

    test("Parse System Commands (health, workers, status, logs)", () => {
        assert.strictEqual(commandParser.parse("health").intent, "HEALTH");
        assert.strictEqual(commandParser.parse("workers").intent, "WORKERS");
        assert.strictEqual(commandParser.parse("status").intent, "STATUS");
        assert.strictEqual(commandParser.parse("logs").intent, "LOGS");
    });

    // --- TEST SUITE 3: Worker Registry & Routing ---
    console.log("\n--- 3. Multi-Worker Orchestration & Routing ---");
    const workerRegistry = require("../packages/worker/WorkerRegistry");

    test("Worker Node Registration", () => {
        const workers = workerRegistry.getAllWorkers();
        assert.strictEqual(workers.length >= 3, true);
        const androidNode = workerRegistry.getWorker("android");
        assert.notStrictEqual(androidNode, null);
        assert.strictEqual(androidNode.id, "android");
    });

    test("Multi-Worker Portal Priority Routing", () => {
        const naukriWorker = workerRegistry.getBestWorkerForPortal("naukri");
        assert.strictEqual(naukriWorker.id, "android");

        const linkedinWorker = workerRegistry.getBestWorkerForPortal("linkedin");
        assert.strictEqual(linkedinWorker.id, "windows");

        const hiristWorker = workerRegistry.getBestWorkerForPortal("hirist");
        assert.strictEqual(hiristWorker.id, "oracle");
    });

    // --- TEST SUITE 4: Android Engine & Battery Monitoring ---
    console.log("\n--- 4. Android Engine & Execution Hardware ---");
    const androidEngine = require("../packages/worker/AndroidExecutionEngine");

    await testAsync("Battery & Device Health Diagnostics", async () => {
        const battery = await androidEngine.getBatteryStatus();
        assert.strictEqual(typeof battery.level, "number");
        assert.strictEqual(typeof battery.charging, "boolean");
    });

    await testAsync("Device Screenshot Capture & Generation", async () => {
        const testPath = path.join(process.cwd(), "screenshots", "test_empirical_ss.png");
        const resPath = await androidEngine.takeScreenshot(testPath);
        assert.strictEqual(fs.existsSync(resPath), true);
        fs.unlinkSync(resPath);
    });

    // --- TEST SUITE 5: Android Worker Lifecycle ---
    console.log("\n--- 5. Android Worker Full Lifecycle (Start/Stop/Pause/Resume) ---");
    const androidWorker = require("../packages/worker/AndroidWorker");

    await testAsync("Health Check Query", async () => {
        const health = await androidWorker.getHealth();
        assert.strictEqual(health.workerId, "android");
        assert.strictEqual(health.status, "online");
    });

    test("Pause and Resume Controls", () => {
        androidWorker.pause();
        assert.strictEqual(androidWorker.status, "paused");
        androidWorker.resume();
        assert.strictEqual(androidWorker.status, "online");
    });

    await testAsync("Execute Task Lifecycle (startJob -> WorkerFinished)", async () => {
        const result = await androidWorker.startJob("naukri", "apply", { limit: 2 });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.appliedCount, 2);
        assert.strictEqual(fs.existsSync(result.screenshotPath), true);
    });

    // --- SUMMARY REPORT ---
    console.log("\n=================================================");
    console.log(` Empirical Validation Completed: ${passedTests}/${totalTests} Tests Passed`);
    console.log("=================================================\n");

    if (passedTests === totalTests) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runEmpiricalValidation().catch(err => {
    console.error("Test suite crashed:", err);
    process.exit(1);
});
