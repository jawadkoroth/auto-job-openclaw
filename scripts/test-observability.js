/**
 * Comprehensive Observability & Application Truth Layer Validation Test Suite
 *
 * Explicitly validates:
 * 1. Scheduled run creates an audit record
 * 2. Telegram run creates an audit record
 * 3. Windows worker task correlation works
 * 4. Successful HTTP submission becomes VERIFIED_APPLIED
 * 5. Explicit HTTP failure becomes APPLICATION_FAILED
 * 6. Click without verification becomes SUBMISSION_PENDING_VERIFICATION
 * 7. Company ATS flow is recorded
 * 8. Secrets are not written into logs
 * 9. Failed automation records the actual failure reason
 * 10. Daily diagnostic report correctly aggregates results
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const db = require("../packages/database");
const eventBus = require("../packages/events/EventBus");
const taskQueue = require("../packages/queue/TaskQueue");
const workerRegistry = require("../packages/worker/WorkerRegistry");
const commandParser = require("../apps/telegram/CommandParser");

const {
    EVENT_TYPES,
    VERDICTS,
    VERIFICATION_LEVELS,
    SensitiveDataSanitizer,
    ApplicationVerdict,
    EvidenceCollector,
    NetworkEvidenceCollector,
    storage,
    workerEventLogger,
    createRunLogger,
    createAttemptLogger
} = require("../packages/observability");

let passed = 0;
let failed = 0;

function test(name, fn) {
    return (async () => {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(`     Error: ${err.message}`);
            if (err.stack) console.error(`     ${err.stack.split("\n")[1]}`);
            failed++;
        }
    })();
}

(async () => {
    console.log("==================================================");
    console.log("🧪 OPENCLAW END-TO-END OBSERVABILITY REGRESSION SUITE");
    console.log("==================================================\n");

    await db.init();

    // -------------------------------------------------------------
    // Test 1: Scheduled run creates an audit record
    // -------------------------------------------------------------
    await test("1. Scheduled run creates an audit record in SQLite and disk", async () => {
        const runLogger = createRunLogger({
            portal: "hirist",
            action: "apply",
            workerId: "oracle",
            triggerType: "SCHEDULED"
        });
        await runLogger.start();
        assert.ok(runLogger.runId.startsWith("hirist-"), "Run ID must have hirist prefix");

        await runLogger.recordDiscovered({ id: "h101", title: "DevOps Engineer", company: "TechCorp" });
        await runLogger.recordSelected({ id: "h101", title: "DevOps Engineer", company: "TechCorp" }, 92);
        runLogger.recordAttemptOutcome({ verdict: VERDICTS.VERIFIED_APPLIED });

        const summary = await runLogger.finish();
        assert.ok(summary.includes(runLogger.runId), "Summary must contain runId");

        const runDb = await db.get("SELECT * FROM automation_runs WHERE run_id = ?", [runLogger.runId]);
        assert.ok(runDb, "Run record must exist in automation_runs table");
        assert.strictEqual(runDb.trigger_type, "SCHEDULED");
        assert.strictEqual(runDb.worker_id, "oracle");
        assert.strictEqual(runDb.status, "COMPLETED");
        assert.strictEqual(runDb.verified_applied_count, 1);
    });

    // -------------------------------------------------------------
    // Test 2: Telegram run creates an audit record
    // -------------------------------------------------------------
    await test("2. Telegram run creates an audit record with correlation tracing", async () => {
        const tgRunId = `telegram-cutshort-${Date.now()}`;
        const taskId = `task-tg-${Date.now()}`;

        const tgRunLogger = createRunLogger({
            portal: "cutshort",
            action: "apply",
            workerId: "oracle",
            runId: tgRunId,
            taskId,
            triggerType: "TELEGRAM_OR_MANUAL"
        });
        await tgRunLogger.start();

        await tgRunLogger.recordDiscovered({ id: "c201", title: "Site Reliability Engineer", company: "CloudScale" });
        await tgRunLogger.recordSelected({ id: "c201", title: "Site Reliability Engineer", company: "CloudScale" }, 88);
        tgRunLogger.recordAttemptOutcome({ verdict: VERDICTS.VERIFIED_APPLIED });
        await tgRunLogger.finish();

        const runDb = await db.get("SELECT * FROM automation_runs WHERE run_id = ?", [tgRunId]);
        assert.ok(runDb, "Telegram run must be persisted");
        assert.strictEqual(runDb.run_id, tgRunId);
        assert.strictEqual(runDb.task_id, taskId);
        assert.strictEqual(runDb.trigger_type, "TELEGRAM_OR_MANUAL");
    });

    // -------------------------------------------------------------
    // Test 3: Windows worker task correlation works
    // -------------------------------------------------------------
    await test("3. Windows worker task correlation works across Queue, Registry, and Events", async () => {
        const winRunId = `windows-naukri-${Date.now()}`;
        const taskId = await taskQueue.push("naukri", "apply", { target: "bangalore" }, "windows", winRunId);
        assert.ok(taskId, "Task ID should be generated");

        const task = await taskQueue.getNext("windows");
        assert.ok(task, "Task fetched for windows worker");
        assert.strictEqual(task.id, taskId);
        assert.strictEqual(task.runId, winRunId);

        await workerEventLogger.logTaskReceived("windows", taskId, "naukri", "apply", winRunId);
        await workerEventLogger.logTaskAcknowledged("windows", taskId, winRunId);
        await workerEventLogger.logTaskStarted("windows", taskId, winRunId, { portal: "naukri" });
        await workerEventLogger.logLauncherStarted("windows", taskId, winRunId, "scripts/naukri-windows-launcher.js");
        await workerEventLogger.logBrowserStarted("windows", winRunId, "naukri");
        await workerEventLogger.logJobProcessing("windows", winRunId, "job-win-1", "DevOps Lead", "InnoTech");
        await workerEventLogger.logApplicationResult("windows", winRunId, "job-win-1", VERDICTS.VERIFIED_APPLIED);
        await workerEventLogger.logLauncherOutcome({
            workerId: "windows",
            taskId,
            runId: winRunId,
            exitCode: 0,
            durationMs: 3200
        });

        await taskQueue.acknowledge(taskId, "windows");
        await taskQueue.complete(taskId, { success: true, exitCode: 0 });

        const workerEvts = await db.all("SELECT * FROM worker_events WHERE run_id = ?", [winRunId]);
        assert.ok(workerEvts.length >= 5, "All Windows worker lifecycle events must be recorded");
        assert.ok(workerEvts.some(e => e.event_type === "LAUNCHER_STARTED"));
        assert.ok(workerEvts.some(e => e.event_type === "JOB_PROCESSING"));
    });

    // -------------------------------------------------------------
    // Test 4: Successful HTTP submission becomes VERIFIED_APPLIED
    // -------------------------------------------------------------
    await test("4. Successful HTTP submission + reload confirmation becomes VERIFIED_APPLIED", () => {
        const vApplied = ApplicationVerdict.resolve({
            applyClicked: true,
            submitClicked: true,
            networkSuccess: true,
            domConfirmed: true,
            reloadConfirmed: true
        });
        assert.strictEqual(vApplied.verdict, VERDICTS.VERIFIED_APPLIED);
        assert.strictEqual(vApplied.applied, 1);
        assert.strictEqual(vApplied.level, VERIFICATION_LEVELS.PAGE_RELOAD_CONFIRMED);
    });

    // -------------------------------------------------------------
    // Test 5: Explicit HTTP failure becomes APPLICATION_FAILED
    // -------------------------------------------------------------
    await test("5. Explicit HTTP failure / Playwright error becomes APPLICATION_FAILED", () => {
        const vFailed = ApplicationVerdict.resolve({
            applyClicked: true,
            submitClicked: true,
            error: "HTTP 500 Internal Server Error on submit endpoint"
        });
        assert.strictEqual(vFailed.verdict, VERDICTS.APPLICATION_FAILED);
        assert.strictEqual(vFailed.applied, 0);
        assert.ok(vFailed.reason.includes("500"));
    });

    // -------------------------------------------------------------
    // Test 6: Click without verification becomes SUBMISSION_PENDING_VERIFICATION
    // -------------------------------------------------------------
    await test("6. Click without authoritative verification becomes SUBMISSION_PENDING_VERIFICATION", () => {
        const vPending = ApplicationVerdict.resolve({
            applyClicked: true,
            submitClicked: true,
            networkSuccess: true,
            domConfirmed: false,
            reloadConfirmed: false
        });
        assert.strictEqual(vPending.verdict, VERDICTS.SUBMISSION_PENDING_VERIFICATION);
        assert.strictEqual(vPending.applied, 0);
    });

    // -------------------------------------------------------------
    // Test 7: Company ATS flow is recorded
    // -------------------------------------------------------------
    await test("7. Company ATS flow and redirect evidence is recorded", async () => {
        const atsRunId = `ats-test-run-${Date.now()}`;
        const attempt = createAttemptLogger({
            runId: atsRunId,
            taskId: "task-ats-1",
            portal: "weworkremotely",
            jobId: "wwr-777",
            company: "Enterprise Corp",
            title: "Senior Cloud Architect",
            applyType: "EXTERNAL",
            sourceUrl: "https://weworkremotely.com/jobs/wwr-777"
        });

        await attempt.recordExternalRedirect({
            destinationUrl: "https://enterprisecorp.greenhouse.io/jobs/998877",
            ats: "GREENHOUSE"
        });

        await attempt.logStep(EVENT_TYPES.ATS_FORM_OPENED, { ats: "GREENHOUSE" });
        await attempt.logStep(EVENT_TYPES.ATS_SUBMIT_ATTEMPTED);

        const res = await attempt.complete({
            submitClicked: true,
            domConfirmed: true,
            networkSuccess: true
        });

        assert.strictEqual(res.verdict, VERDICTS.VERIFIED_APPLIED);

        const attemptRow = await db.get("SELECT * FROM application_attempts WHERE attempt_id = ?", [attempt.attemptId]);
        assert.ok(attemptRow, "Attempt must exist in DB");
        assert.strictEqual(attemptRow.ats, "GREENHOUSE");
        assert.strictEqual(attemptRow.apply_type, "EXTERNAL");
        assert.strictEqual(attemptRow.destination_url, "https://enterprisecorp.greenhouse.io/jobs/998877");
    });

    // -------------------------------------------------------------
    // Test 8: Secrets are not written into logs
    // -------------------------------------------------------------
    await test("8. Secrets, tokens, passwords and cookies are redacted and never logged", () => {
        const rawHeaders = {
            "authorization": "Bearer ya29.a0AfH6SMD_secret123456789",
            "cookie": "session_id=abcdef123456; csrf=xyz890",
            "x-telegram-bot-token": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345",
            "content-type": "application/json"
        };
        const cleanHeaders = SensitiveDataSanitizer.sanitizeHeaders(rawHeaders);
        assert.strictEqual(cleanHeaders["authorization"], "[REDACTED_BEARER_TOKEN]");
        assert.strictEqual(cleanHeaders["cookie"], "[REDACTED_COOKIE]");
        assert.strictEqual(cleanHeaders["content-type"], "application/json");

        const rawJson = {
            password: "CandidatePassword123!",
            otp: "998877",
            token: "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345",
            user: "johndoe@example.com"
        };
        const cleanJson = SensitiveDataSanitizer.sanitize(rawJson);
        assert.strictEqual(cleanJson.password, "[REDACTED]");
        assert.strictEqual(cleanJson.otp, "[REDACTED]");
        assert.strictEqual(cleanJson.token, "[REDACTED]");
        assert.strictEqual(cleanJson.user, "johndoe@example.com");
    });

    // -------------------------------------------------------------
    // Test 9: Failed automation records the actual failure reason
    // -------------------------------------------------------------
    await test("9. Failed automation records the actual failure reason and zero reason", async () => {
        const failRun = createRunLogger({
            portal: "naukri",
            action: "apply",
            workerId: "windows",
            triggerType: "SCHEDULED"
        });
        await failRun.start();

        await failRun.recordDiscovered({ id: "fail-j1", title: "DevOps Engineer" });
        await failRun.recordRejection({ id: "fail-j1" }, "EXPERIENCE", "Job requires 8+ YOE, profile has 4 YOE");

        const summary = await failRun.finish();
        assert.strictEqual(failRun.appliedCount, 0);
        assert.strictEqual(failRun.zeroReason, "ALL_CANDIDATES_REJECTED_EXPERIENCE");
        assert.ok(summary.includes("ALL_CANDIDATES_REJECTED_EXPERIENCE"));

        const runDb = await db.get("SELECT * FROM automation_runs WHERE run_id = ?", [failRun.runId]);
        assert.strictEqual(runDb.zero_reason, "ALL_CANDIDATES_REJECTED_EXPERIENCE");
    });

    // -------------------------------------------------------------
    // Test 10: Daily diagnostic report correctly aggregates results
    // -------------------------------------------------------------
    await test("10. Daily diagnostic report correctly aggregates all runs, jobs, and rates", async () => {
        const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const summary = await storage.getDailySummary(todayStr);

        assert.ok(summary, "Summary object must be returned");
        assert.ok(summary.totalRuns > 0, "Should aggregate today's runs");
        assert.ok(summary.discovered > 0, "Should aggregate discovered jobs");
        assert.ok(typeof summary.successRate === "string", "Success rate must be string formatted percentage");
        assert.ok(summary.portalStats.hirist || summary.portalStats.cutshort || summary.portalStats.naukri, "Portal stats must exist");
    });

    console.log("\n==================================================");
    console.log(`TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log("==================================================");

    if (failed > 0) {
        process.exit(1);
    }
    process.exit(0);
})();
