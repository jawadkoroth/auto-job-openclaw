/**
 * Empirical Validation Suite — Hardened Telegram Task Lifecycle & Script Execution
 */

const assert = require("assert");
const scriptRunner = require("../packages/worker/ScriptRunner");
const androidWorker = require("../packages/worker/AndroidWorker");
const eventBus = require("../packages/events/EventBus");

async function runHardenedLifecycleValidation() {
    console.log("=================================================");
    console.log("  Hardened Task Lifecycle Empirical Validation");
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

    // --- TEST 1: ScriptRunner Path Resolution ---
    test("ScriptRunner resolves real script path for naukri.updateProfile", () => {
        const resolvedPath = scriptRunner.resolveScriptPath("naukri", "updateProfile");
        assert.notStrictEqual(resolvedPath, null);
        assert.strictEqual(resolvedPath.includes("run-naukri-profile-refresh.js"), true);
    });

    // --- TEST 2: Real Script Execution & Lifecycle Log Capture ---
    await testAsync("Real Child Process Execution Await & Lifecycle Logs", async () => {
        console.log("  ⏳ Spawning child process `scripts/run-naukri-profile-refresh.js` and awaiting completion...");
        const res = await scriptRunner.runScript("naukri", "updateProfile", {});

        console.log(`  📊 Child Process Completed: Exit Code = ${res.exitCode}, Duration = ${(res.durationMs / 1000).toFixed(1)}s`);
        
        // Assert execution duration is realistic (> 3 seconds)
        assert.strictEqual(res.durationMs > 3000, true, "Real Playwright execution must take more than 3 seconds");

        // Verify lifecycle logs in stdout
        const stdout = res.stdout;
        assert.strictEqual(stdout.includes("[LIFECYCLE] START"), true, "Must log [LIFECYCLE] START");
        assert.strictEqual(stdout.includes("[LIFECYCLE] PLAYWRIGHT_LAUNCHED"), true, "Must log [LIFECYCLE] PLAYWRIGHT_LAUNCHED");

        if (res.exitCode === 0) {
            assert.strictEqual(stdout.includes("[LIFECYCLE] VERIFICATION_PASSED"), true, "Must log [LIFECYCLE] VERIFICATION_PASSED");
            assert.strictEqual(stdout.includes("[LIFECYCLE] FINISHED"), true, "Must log [LIFECYCLE] FINISHED");
        }
    });

    // --- TEST 3: AndroidWorker Full Await & WorkerFinished Event Ownership ---
    await testAsync("AndroidWorker startJob awaits child process before emitting WorkerFinished", async () => {
        let workerFinishedEmitted = false;
        let eventData = null;

        const onFinished = (data) => {
            if (data.portal === "naukri" && data.action === "updateProfile") {
                workerFinishedEmitted = true;
                eventData = data;
            }
        };

        eventBus.on("WorkerFinished", onFinished);

        console.log("  ⏳ Triggering androidWorker.startJob('naukri', 'updateProfile')...");
        const startTime = Date.now();
        const startRes = await androidWorker.startJob("naukri", "updateProfile", { limit: 1 });
        const duration = Date.now() - startTime;

        eventBus.removeListener("WorkerFinished", onFinished);

        console.log(`  📊 Worker startJob returned after ${(duration / 1000).toFixed(1)}s. Success = ${startRes.success}`);

        assert.strictEqual(workerFinishedEmitted, true, "WorkerFinished must be emitted upon completion");
        assert.strictEqual(duration > 3000, true, "Worker must NOT return prematurely before child script finishes");
        assert.strictEqual(eventData.result.durationMs > 0, true, "WorkerFinished payload must include actual durationMs");
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

runHardenedLifecycleValidation().catch(err => {
    console.error("Verification crashed:", err);
    process.exit(1);
});
