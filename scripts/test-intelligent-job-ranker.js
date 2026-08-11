const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const assert = require("assert");

console.log("==================================================");
console.log("INTELLIGENT JOB RANKER PRODUCTION VALIDATION SUITE");
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

// 1. SRE Role Exclusion Validation
console.log("--- TEST GROUP 1: SRE Role Exclusion ---");
const sreTestCases = [
    "Site Reliability Engineer",
    "SRE",
    "Senior SRE",
    "Lead SRE",
    "Principal SRE",
    "Reliability Engineer",
    "Reliability Platform Engineer",
    "DevOps / SRE Engineer",
    "Site Reliability & Cloud Engineer"
];

for (const title of sreTestCases) {
    runTest(`Exclude SRE role title: "${title}"`, () => {
        const isSre = intelligentJobRanker.isSreRole(title);
        assert.strictEqual(isSre, true, `Title "${title}" must be identified as an SRE role`);
        const rank = intelligentJobRanker.rankJob({ title, experience: "2-4 Yrs", location: "Bangalore" });
        assert.strictEqual(rank.isEligible, false, `Job "${title}" must be marked ineligible`);
        assert.strictEqual(rank.rankScore, 0, `Job "${title}" must have rankScore 0`);
    });
}

console.log("\n--- TEST GROUP 2: Kept Roles Eligibility ---");
const keptTestCases = [
    "DevOps Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Infrastructure Engineer",
    "Cloud Platform Engineer",
    "DevOps Platform Engineer",
    "Cloud Infrastructure Engineer",
    "AWS Engineer",
    "Azure DevOps Engineer",
    "Kubernetes Engineer",
    "MLOps Engineer",
    "Platform Operations Engineer"
];

for (const title of keptTestCases) {
    runTest(`Keep role title eligible: "${title}"`, () => {
        const isSre = intelligentJobRanker.isSreRole(title);
        assert.strictEqual(isSre, false, `Title "${title}" must NOT be identified as an SRE role`);
        const rank = intelligentJobRanker.rankJob({ title, experience: "2-4 Yrs", location: "Bangalore" });
        assert.strictEqual(rank.isEligible, true, `Job "${title}" must be eligible`);
        assert.ok(rank.rankScore > 0, `Job "${title}" rankScore must be > 0`);
    });
}

// 2. Recency Boost Validation
console.log("\n--- TEST GROUP 3: Recency Boost Scoring ---");
runTest("Recency scoring: <24h (+100) > 1-3d (+70) > 4-7d (+40) > 8-15d (+15) > Older (0)", () => {
    const job24h = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Just Posted" };
    const job3d = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "2 days ago" };
    const job7d = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "5 days ago" };
    const job15d = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "10 days ago" };
    const jobOlder = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "30 days ago" };

    const score24h = intelligentJobRanker.calculateRecencyScore(job24h);
    const score3d = intelligentJobRanker.calculateRecencyScore(job3d);
    const score7d = intelligentJobRanker.calculateRecencyScore(job7d);
    const score15d = intelligentJobRanker.calculateRecencyScore(job15d);
    const scoreOlder = intelligentJobRanker.calculateRecencyScore(jobOlder);

    assert.strictEqual(score24h, 100, "<24h score must be 100");
    assert.strictEqual(score3d, 80, "2 days ago score must be 80");
    assert.strictEqual(score7d, 40, "5 days ago score must be 40");
    assert.strictEqual(score15d, 10, "10 days ago score must be 10");
    assert.strictEqual(scoreOlder, 0, "Older score must be 0");
});

// 3. YOE Priority Scoring Validation
console.log("\n--- TEST GROUP 4: YOE Priority Bonus Scoring ---");
runTest("YOE bonus table: 2-4 (+100) > 1-3 (+80) > 2-5 (+70) > 3-5 (+60) > 1-4 (+50) > 3-6 (+40) > 0-3 (+20) > 4-6 (+10) > others (0)", () => {
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("2-4 Yrs"), 100);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("1-3 Yrs"), 80);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("2-5 Yrs"), 70);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("3-5 Yrs"), 60);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("1-4 Yrs"), 50);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("3-6 Yrs"), 40);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("0-3 Yrs"), 20);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("4-6 Yrs"), 10);
    assert.strictEqual(intelligentJobRanker.calculateYoeBonus("5-7 Yrs"), 0);
});

runTest("2-4 YOE ranks above 0-3 YOE and 5-7 YOE jobs", () => {
    const job2to4 = { title: "Cloud Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today" };
    const job0to3 = { title: "Cloud Engineer", experience: "0-3 Yrs", location: "Bangalore", postedDate: "Today" };
    const job5to7 = { title: "Cloud Engineer", experience: "5-7 Yrs", location: "Bangalore", postedDate: "Today" };

    const rank2to4 = intelligentJobRanker.rankJob(job2to4);
    const rank0to3 = intelligentJobRanker.rankJob(job0to3);
    const rank5to7 = intelligentJobRanker.rankJob(job5to7);

    assert.ok(rank2to4.rankScore > rank0to3.rankScore, `2-4 YOE (${rank2to4.rankScore}) must rank above 0-3 YOE (${rank0to3.rankScore})`);
    assert.ok(rank2to4.rankScore > rank5to7.rankScore, `2-4 YOE (${rank2to4.rankScore}) must rank above 5-7 YOE (${rank5to7.rankScore})`);
});

// 4. Ranking Order Hierarchy Validation
console.log("\n--- TEST GROUP 5: Ranking Order Hierarchy ---");
runTest("Native Apply ranks above External Apply", () => {
    const nativeJob = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", isExternal: false };
    const externalJob = { title: "DevOps Engineer", experience: "2-4 Yrs", location: "Bangalore", isExternal: true };

    const rankNative = intelligentJobRanker.rankJob(nativeJob);
    const rankExternal = intelligentJobRanker.rankJob(externalJob);

    assert.ok(rankNative.rankScore > rankExternal.rankScore, `Native job (${rankNative.rankScore}) must rank above External job (${rankExternal.rankScore})`);
});

runTest("rankAndSortJobs correctly sorts candidate pool descending", () => {
    const candidates = [
        { title: "Senior SRE", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Today" },
        { title: "DevOps Engineer", experience: "0-3 Yrs", location: "Bangalore", postedDate: "5 days ago" },
        { title: "Platform Engineer", experience: "2-4 Yrs", location: "Bangalore", postedDate: "Just Posted" },
        { title: "Cloud Engineer", experience: "1-3 Yrs", location: "Remote / India", postedDate: "2 days ago" }
    ];

    const sorted = intelligentJobRanker.rankAndSortJobs(candidates);
    assert.strictEqual(sorted.length, 3, "SRE job must be excluded from candidate pool");
    assert.strictEqual(sorted[0].title, "Platform Engineer", "Top job must be Platform Engineer (2-4 YOE + Just Posted)");
    assert.ok(sorted[0].rankScore > sorted[1].rankScore);
    assert.ok(sorted[1].rankScore > sorted[2].rankScore);
});

console.log("\n==================================================");
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("==================================================");

if (failed > 0) {
    process.exit(1);
}
