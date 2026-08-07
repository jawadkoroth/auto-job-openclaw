const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const assert = require("assert");

console.log("==================================================");
console.log("INTELLIGENT JOB RANKER V2 PRODUCTION TEST SUITE");
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

// 1. Apply Type Scoring & Detection Tests
console.log("--- TEST GROUP 1: Apply Type Detection & Scoring ---");
runTest("Apply Type Detection: Native (+400) > Easy Apply (+250) > External (-100)", () => {
    assert.strictEqual(intelligentJobRanker.detectApplyType({ applyType: "NATIVE" }), "NATIVE");
    assert.strictEqual(intelligentJobRanker.detectApplyType({ isEasyApply: true }), "EASY_APPLY");
    assert.strictEqual(intelligentJobRanker.detectApplyType({ buttonText: "Easy Apply" }), "EASY_APPLY");
    assert.strictEqual(intelligentJobRanker.detectApplyType({ buttonText: "Apply on company site" }), "EXTERNAL");
    assert.strictEqual(intelligentJobRanker.detectApplyType({ portal: "weworkremotely" }), "EXTERNAL");
    assert.strictEqual(intelligentJobRanker.detectApplyType({ portal: "naukri" }), "NATIVE");
});

runTest("Apply Type Score Ranking: Native > Easy Apply > External", () => {
    const nativeJob = { portal: "naukri", title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today", isNative: true };
    const easyJob = { portal: "linkedin", title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today", isEasyApply: true };
    const externalJob = { portal: "linkedin", title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today", isExternal: true };

    const rankNative = intelligentJobRanker.rankJob(nativeJob);
    const rankEasy = intelligentJobRanker.rankJob(easyJob);
    const rankExternal = intelligentJobRanker.rankJob(externalJob);

    assert.strictEqual(rankNative.breakdown.applyTypeScore, 400);
    assert.strictEqual(rankEasy.breakdown.applyTypeScore, 250);
    assert.strictEqual(rankExternal.breakdown.applyTypeScore, -100);

    assert.ok(rankNative.rankScore > rankEasy.rankScore, `Native (${rankNative.rankScore}) > Easy Apply (${rankEasy.rankScore})`);
    assert.ok(rankEasy.rankScore > rankExternal.rankScore, `Easy Apply (${rankEasy.rankScore}) > External (${rankExternal.rankScore})`);
});

// 2. Continuous Recency Scoring Tests
console.log("\n--- TEST GROUP 2: Continuous Recency Scoring ---");
runTest("Continuous Recency Scoring: 0-24h (100) > 24-48h (80) > 48-72h (60) > 3-5d (40) > 5-7d (25) > 7-15d (10) > Older/Missing (0)", () => {
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "Just Posted" }), 100);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "2 days ago" }), 80);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "3 days ago" }), 60);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "4 days ago" }), 40);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "6 days ago" }), 25);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "10 days ago" }), 10);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({ postedDate: "30 days ago" }), 0);
    assert.strictEqual(intelligentJobRanker.calculateRecencyScore({}), 0);
});

// 3. Global 9-Tier Priority Sorting
console.log("\n--- TEST GROUP 3: Global 9-Tier Candidate Pool Sorting ---");
runTest("Candidate pool is correctly sorted according to Global 9-Tier priority", () => {
    const candidatePool = [
        { title: "Senior SRE", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today" }, // Excluded SRE
        { title: "Cloud Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "5 days ago", isExternal: true }, // External
        { title: "Platform Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today", isEasyApply: true }, // Easy Apply
        { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today", isNative: true } // Native Apply
    ];

    const sorted = intelligentJobRanker.rankAndSortJobs(candidatePool);
    assert.strictEqual(sorted.length, 3, "SRE job must be excluded");
    assert.strictEqual(sorted[0].title, "DevOps Engineer", "1st should be Native Apply");
    assert.strictEqual(sorted[1].title, "Platform Engineer", "2nd should be Easy Apply");
    assert.strictEqual(sorted[2].title, "Cloud Engineer", "3rd should be External");
});

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("==================================================");

if (failed > 0) {
    process.exit(1);
}
