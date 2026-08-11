const assert = require("assert");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const db = require("../packages/database");

console.log("==================================================");
console.log("HIRIST ORACLE AUTOMATION REGRESSION TEST SUITE");
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

(async () => {
    // 1. Target DevOps / Cloud / Infrastructure / Platform Role Eligibility Tests
    console.log("--- TEST GROUP 1: Target Role Eligibility ---");
    runTest("Valid DevOps Engineer job is eligible", () => {
        const job = { portal: "hirist", title: "DevOps Engineer", company: "Acme Corp", location: "Bangalore", experience: "2 - 4 Years", url: "https://www.hirist.tech/j/12345" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, true);
    });

    runTest("Valid Cloud Engineer job is eligible", () => {
        const job = { portal: "hirist", title: "Cloud Engineer", company: "CloudScale Tech", location: "Remote", experience: "2-5 Yrs", url: "https://www.hirist.tech/j/12346" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, true);
    });

    runTest("Valid Infrastructure Engineer job is eligible", () => {
        const job = { portal: "hirist", title: "Infrastructure Engineer", company: "InfraCorp", location: "Gurgaon", experience: "3-5 Yrs", url: "https://www.hirist.tech/j/12347" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, true);
    });

    runTest("Valid Platform Engineer job is eligible", () => {
        const job = { portal: "hirist", title: "Platform Engineer", company: "Platform Systems", location: "Hyderabad", experience: "2-4 Yrs", url: "https://www.hirist.tech/j/12348" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, true);
    });

    // 2. Mandatory SRE Exclusion
    console.log("\n--- TEST GROUP 2: SRE Exclusion Rule ---");
    runTest("Site Reliability Engineer (SRE) job is rejected", () => {
        const job = { portal: "hirist", title: "Site Reliability Engineer", company: "Reliability Inc", location: "Bangalore", experience: "2-4 Yrs" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, false);
        assert.ok(rank.ineligibleReason.includes("SRE_EXCLUDED"));
    });

    runTest("Lead SRE job is rejected", () => {
        const job = { portal: "hirist", title: "Lead SRE - Cloud Infrastructure", company: "Reliability Inc", location: "Bangalore", experience: "3-5 Yrs" };
        const rank = intelligentJobRanker.rankJob(job);
        assert.strictEqual(rank.isEligible, false);
        assert.ok(rank.ineligibleReason.includes("SRE_EXCLUDED"));
    });

    // 3. Experience Eligibility & Priority Scoring Tests
    console.log("\n--- TEST GROUP 3: Experience Eligibility & Priority Scoring ---");
    runTest("7-10 YOE job is rejected (>6 YOE policy)", () => {
        const expCheck = checkExperienceEligibility("7 - 10 Yrs");
        assert.strictEqual(expCheck.eligible, false);
    });

    runTest("8+ YOE job is rejected (>6 YOE policy)", () => {
        const expCheck = checkExperienceEligibility("8+ Years");
        assert.strictEqual(expCheck.eligible, false);
    });

    runTest("2–4 YOE receives highest YOE priority bonus (+100)", () => {
        const bonus24 = intelligentJobRanker.calculateYoeBonus("2 - 4 Years");
        const bonus25 = intelligentJobRanker.calculateYoeBonus("2 - 5 Yrs");
        assert.strictEqual(bonus24, 100);
        assert.ok(bonus24 > bonus25, `2-4 YOE (${bonus24}) > 2-5 YOE (${bonus25})`);
    });

    // 4. Continuous Recency Scoring Tests
    console.log("\n--- TEST GROUP 4: Recency Scoring ---");
    runTest("<24h posted job receives top recency score (+100)", () => {
        const scoreToday = intelligentJobRanker.calculateRecencyScore({ postedDate: "Posted Today" });
        const score2d = intelligentJobRanker.calculateRecencyScore({ postedDate: "2 days ago" });
        assert.strictEqual(scoreToday, 100);
        assert.strictEqual(score2d, 80);
        assert.ok(scoreToday > score2d);
    });

    // 5. Location Eligibility Expansion Tests
    console.log("\n--- TEST GROUP 5: Location Eligibility Expansion ---");
    runTest("Gurgaon, Noida, Chennai, Kochi, Trivandrum are India eligible", () => {
        assert.strictEqual(checkLocationEligibility("Gurgaon", "DevOps").eligible, true);
        assert.strictEqual(checkLocationEligibility("Noida", "DevOps").eligible, true);
        assert.strictEqual(checkLocationEligibility("Chennai", "DevOps").eligible, true);
        assert.strictEqual(checkLocationEligibility("Kochi", "DevOps").eligible, true);
        assert.strictEqual(checkLocationEligibility("Trivandrum", "DevOps").eligible, true);
    });

    runTest("Unrestricted Remote / Work From Home is Remote eligible", () => {
        assert.strictEqual(checkLocationEligibility("Remote", "DevOps Engineer").eligible, true);
        assert.strictEqual(checkLocationEligibility("Work From Home", "Cloud Engineer").eligible, true);
    });

    runTest("US Restricted Remote job is rejected", () => {
        assert.strictEqual(checkLocationEligibility("Remote (US Only)", "DevOps").eligible, false);
    });

    // 6. Duplicate State Protection & DISCOVERED Status Handling
    console.log("\n--- TEST GROUP 6: Duplicate Protection & State Logic ---");
    await runAsyncTest("DISCOVERED status is NOT treated as duplicate", async () => {
        await db.init();
        const testJobId = `test-disc-${Date.now()}`;
        await db.run("INSERT INTO jobs (portal, job_id, title, status) VALUES (?, ?, ?, ?)", ["hirist", testJobId, "Test Job", "DISCOVERED"]);
        
        const isDup = await db.isDuplicateJob("hirist", testJobId);
        assert.strictEqual(isDup, false, "DISCOVERED job must NOT be treated as duplicate");
    });

    await runAsyncTest("APPLIED and ALREADY_APPLIED statuses ARE treated as duplicates", async () => {
        await db.init();
        const testJobId1 = `test-applied-${Date.now()}`;
        const testJobId2 = `test-already-${Date.now()}`;

        await db.run("INSERT INTO jobs (portal, job_id, title, status) VALUES (?, ?, ?, ?)", ["hirist", testJobId1, "Test Job 1", "APPLIED"]);
        await db.run("INSERT INTO jobs (portal, job_id, title, status) VALUES (?, ?, ?, ?)", ["hirist", testJobId2, "Test Job 2", "ALREADY_APPLIED"]);

        const isDup1 = await db.isDuplicateJob("hirist", testJobId1);
        const isDup2 = await db.isDuplicateJob("hirist", testJobId2);

        assert.strictEqual(isDup1, true, "APPLIED job must be protected as duplicate");
        assert.strictEqual(isDup2, true, "ALREADY_APPLIED job must be protected as duplicate");
    });

    console.log("\n==================================================");
    console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("==================================================");

    if (failed > 0) {
        process.exit(1);
    }
})();
