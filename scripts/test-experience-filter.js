const { checkExperienceEligibility, parseExperience } = require("../packages/router/ExperienceEligibilityFilter");

const testCases = [
    { input: "0-1", expectedEligible: true, desc: "0-1" },
    { input: "0-2", expectedEligible: true, desc: "0-2" },
    { input: "0-3", expectedEligible: true, desc: "0-3" },
    { input: "0-5", expectedEligible: true, desc: "0-5" },
    { input: "0-6", expectedEligible: true, desc: "0-6" },
    { input: "1-2", expectedEligible: true, desc: "1-2" },
    { input: "1-3", expectedEligible: true, desc: "1-3" },
    { input: "1-6", expectedEligible: true, desc: "1-6" },
    { input: "2-4", expectedEligible: true, desc: "2-4" },
    { input: "2-6", expectedEligible: true, desc: "2-6" },
    { input: "3-5", expectedEligible: true, desc: "3-5" },
    { input: "4-6", expectedEligible: true, desc: "4-6" },
    { input: "5-8", expectedEligible: true, desc: "5-8 (overlaps 1-6)" },
    { input: "6-10", expectedEligible: true, desc: "6-10 (6 overlaps)" },
    { input: "7-10", expectedEligible: false, desc: "7-10 (does not overlap)" },

    // String Formats
    { input: "0-3 yrs", expectedEligible: true, desc: "0-3 yrs format" },
    { input: "0 - 3 years", expectedEligible: true, desc: "0 - 3 years format" },
    { input: "1-6 Years", expectedEligible: true, desc: "1-6 Years format" },
    { input: "3+ years", expectedEligible: true, desc: "3+ years format" },
    { input: "Up to 5 years", expectedEligible: true, desc: "Up to 5 years format" },
    { input: "Minimum 2 years", expectedEligible: true, desc: "Minimum 2 years format" },
    { input: "2 to 5 years", expectedEligible: true, desc: "2 to 5 years format" },
    { input: "Fresher", expectedEligible: true, desc: "Fresher" },
    { input: "Entry Level", expectedEligible: true, desc: "Entry Level" },
    { input: "", expectedEligible: true, desc: "empty string (UNKNOWN)" },
    { input: null, expectedEligible: true, desc: "null (UNKNOWN)" },
    { input: undefined, expectedEligible: true, desc: "undefined (UNKNOWN)" },
    { input: "8+ years", expectedEligible: false, desc: "8+ years (REJECT)" }
];

console.log("==================================================");
console.log("EXPERIENCE ELIGIBILITY FILTER REGRESSION TEST SUITE");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

for (const tc of testCases) {
    const res = checkExperienceEligibility(tc.input);
    const pass = res.eligible === tc.expectedEligible;
    if (pass) {
        passed++;
        console.log(`✓ PASS: "${tc.input}" (${tc.desc}) -> eligible=${res.eligible} [${res.category}]`);
    } else {
        failed++;
        console.error(`❌ FAIL: "${tc.input}" (${tc.desc}) -> expected ${tc.expectedEligible}, got ${res.eligible} [${res.category}] - ${res.reason}`);
    }
}

console.log("\n==================================================");
console.log(`TOTAL: ${testCases.length} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("==================================================");

if (failed > 0) {
    process.exit(1);
}
