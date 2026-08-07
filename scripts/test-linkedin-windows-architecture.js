const path = require("path");
const fs = require("fs-extra");
const assert = require("assert");
const commandParser = require("../apps/telegram/CommandParser");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const LinkedInConcurrencyLock = require("../packages/plugins/linkedin/LinkedInConcurrencyLock");

console.log("==================================================");
console.log("LINKEDIN WINDOWS ARCHITECTURE VALIDATION SUITE");
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

// 1. Lock Mechanism
console.log("--- TEST GROUP 1: LinkedIn Concurrency Lock ---");
runTest("Acquire and release LinkedInConcurrencyLock", () => {
    const lock1 = new LinkedInConcurrencyLock("test_linkedin_unit.lock");
    assert.strictEqual(lock1.acquire(), true, "First lock acquisition must succeed");
    
    const lock2 = new LinkedInConcurrencyLock("test_linkedin_unit.lock");
    assert.strictEqual(lock2.acquire(), false, "Second lock acquisition must be prevented");

    lock1.release();
    assert.strictEqual(lock2.acquire(), true, "Lock acquisition after release must succeed");
    lock2.release();
});

// 2. Command Routing for LinkedIn Worker
console.log("\n--- TEST GROUP 2: Command Routing for LinkedIn ---");
runTest("Default 'start linkedin' routes to Windows Worker", () => {
    const parsed = commandParser.parse("start linkedin");
    assert.strictEqual(parsed.portal, "linkedin");
    const worker = workerRegistry.getBestWorkerForPortal(parsed.portal, parsed.targetWorker);
    assert.strictEqual(worker.id, "windows", "Default 'start linkedin' must select Windows Worker");
});

runTest("Explicit 'start linkedin pc' and 'start linkedin windows' route to Windows Worker", () => {
    const parsedPc = commandParser.parse("start linkedin pc");
    const workerPc = workerRegistry.getBestWorkerForPortal(parsedPc.portal, parsedPc.targetWorker);
    assert.strictEqual(workerPc.id, "windows");

    const parsedWin = commandParser.parse("start linkedin windows");
    const workerWin = workerRegistry.getBestWorkerForPortal(parsedWin.portal, parsedWin.targetWorker);
    assert.strictEqual(workerWin.id, "windows");
});

runTest("Explicit 'start linkedin mobile' and 'start linkedin android' route to Android Worker", () => {
    const parsedMob = commandParser.parse("start linkedin mobile");
    const workerMob = workerRegistry.getBestWorkerForPortal(parsedMob.portal, parsedMob.targetWorker);
    assert.strictEqual(workerMob.id, "android");

    const parsedAnd = commandParser.parse("start linkedin android");
    const workerAnd = workerRegistry.getBestWorkerForPortal(parsedAnd.portal, parsedAnd.targetWorker);
    assert.strictEqual(workerAnd.id, "android");
});

runTest("Explicit 'start linkedin oracle' routes to Oracle Worker", () => {
    const parsedOra = commandParser.parse("start linkedin oracle");
    const workerOra = workerRegistry.getBestWorkerForPortal(parsedOra.portal, parsedOra.targetWorker);
    assert.strictEqual(workerOra.id, "oracle");
});

// 3. Schedule State Persistence Directory
console.log("\n--- TEST GROUP 3: Schedule State Directory ---");
runTest("Sessions directory structure for LinkedIn exists or can be initialized", () => {
    const sessionDir = path.join(process.cwd(), "sessions", "linkedin");
    fs.mkdirpSync(sessionDir);
    assert.strictEqual(fs.existsSync(sessionDir), true);
});

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("==================================================");

if (failed > 0) {
    process.exit(1);
}
