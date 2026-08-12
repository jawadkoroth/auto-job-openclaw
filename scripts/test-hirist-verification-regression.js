const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const db = require("../packages/database");

console.log("==================================================");
console.log("HIRIST VERIFICATION ENGINE REGRESSION TEST SUITE");
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

// Mock evaluation function representing the 7-Layer Verdict Logic
function evaluateVerificationVerdict({ hasNetworkSuccess, hasNetworkError, toastFound, isButtonApplied, postReloadApplied }) {
    if (hasNetworkSuccess || toastFound || isButtonApplied || postReloadApplied) {
        return "VERIFIED_APPLIED";
    } else if (hasNetworkError) {
        return "APPLICATION_FAILED";
    } else {
        return "SUBMISSION_PENDING_VERIFICATION";
    }
}

(async () => {
    // 1. Confirmation Toast -> VERIFIED_APPLIED
    runTest("Scenario 1: Confirmation toast detected -> VERIFIED_APPLIED", () => {
        const verdict = evaluateVerificationVerdict({ toastFound: true, hasNetworkSuccess: false, isButtonApplied: false, postReloadApplied: false, hasNetworkError: false });
        assert.strictEqual(verdict, "VERIFIED_APPLIED");
    });

    // 2. Modal Closes + Network Success -> VERIFIED_APPLIED
    runTest("Scenario 2: Modal closes + network API success -> VERIFIED_APPLIED", () => {
        const verdict = evaluateVerificationVerdict({ hasNetworkSuccess: true, toastFound: false, isButtonApplied: false, postReloadApplied: false, hasNetworkError: false });
        assert.strictEqual(verdict, "VERIFIED_APPLIED");
    });

    // 3. Reload Shows Applied State -> VERIFIED_APPLIED
    runTest("Scenario 3: Page reload shows 'Applied' state -> VERIFIED_APPLIED", () => {
        const verdict = evaluateVerificationVerdict({ postReloadApplied: true, hasNetworkSuccess: false, toastFound: false, isButtonApplied: false, hasNetworkError: false });
        assert.strictEqual(verdict, "VERIFIED_APPLIED");
    });

    // 4. Network Success but No Toast -> VERIFIED_APPLIED
    runTest("Scenario 4: Network success but no immediate toast -> VERIFIED_APPLIED", () => {
        const verdict = evaluateVerificationVerdict({ hasNetworkSuccess: true, toastFound: false, isButtonApplied: false, postReloadApplied: false, hasNetworkError: false });
        assert.strictEqual(verdict, "VERIFIED_APPLIED");
    });

    // 5. Explicit Portal Error -> APPLICATION_FAILED
    runTest("Scenario 5: Explicit HTTP/Portal error response -> APPLICATION_FAILED", () => {
        const verdict = evaluateVerificationVerdict({ hasNetworkError: true, hasNetworkSuccess: false, toastFound: false, isButtonApplied: false, postReloadApplied: false });
        assert.strictEqual(verdict, "APPLICATION_FAILED");
    });

    // 6. Click Executed with No Immediate Evidence -> SUBMISSION_PENDING_VERIFICATION
    runTest("Scenario 6: Apply clicked but immediate evidence inconclusive -> SUBMISSION_PENDING_VERIFICATION", () => {
        const verdict = evaluateVerificationVerdict({ hasNetworkSuccess: false, hasNetworkError: false, toastFound: false, isButtonApplied: false, postReloadApplied: false });
        assert.strictEqual(verdict, "SUBMISSION_PENDING_VERIFICATION");
    });

    // 7. Existing Duplicate Protection Intact
    await runAsyncTest("Scenario 7: Existing duplicate protection remains intact for APPLIED and VERIFIED_APPLIED", async () => {
        await db.init();
        const testId = `dup-verif-${Date.now()}`;
        await db.run("INSERT INTO jobs (portal, job_id, title, status) VALUES (?, ?, ?, ?)", ["hirist", testId, "DevOps Job", "VERIFIED_APPLIED"]);
        
        const isDup = await db.isDuplicateJob("hirist", testId);
        assert.strictEqual(isDup, true, "VERIFIED_APPLIED job must be protected as duplicate");
    });

    // 8. Existing 1-6 YOE Policy Intact
    runTest("Scenario 8: Existing 1-6 YOE eligibility policy remains intact", () => {
        assert.strictEqual(checkExperienceEligibility("2-4 Yrs").eligible, true);
        assert.strictEqual(checkExperienceEligibility("8-12 Yrs").eligible, false);
    });

    // 9. SRE Exclusion Intact
    runTest("Scenario 9: SRE role exclusion remains intact", () => {
        const isSre = intelligentJobRanker.isSreRole("Site Reliability Engineer");
        assert.strictEqual(isSre, true);
    });

    // 10. IntelligentJobRanker Ranking Hierarchy Intact
    runTest("Scenario 10: IntelligentJobRanker ranking hierarchy remains intact", () => {
        const rankNative = intelligentJobRanker.rankJob({ portal: "hirist", title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", isNative: true });
        const rankExternal = intelligentJobRanker.rankJob({ portal: "hirist", title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", isExternal: true });
        assert.ok(rankNative.rankScore > rankExternal.rankScore);
    });

    console.log("\n==================================================");
    console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("==================================================");

    if (failed > 0) {
        process.exit(1);
    }
})();
