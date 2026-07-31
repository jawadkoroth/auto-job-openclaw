const assert = require("assert");
const atsClassifier = require("../packages/engine/ATSClassifier");
const questionnaireEngine = require("../packages/engine/QuestionnaireEngine");
const externalApplicationRouter = require("../packages/engine/ExternalApplicationRouter");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");

(async () => {
    console.log("==================================================");
    console.log("RUNNING EXTERNAL APPLICATION ENGINE SYNTHETIC TESTS");
    console.log("==================================================\n");

    // Test 1: ATS Classifier URL & Domain Classification
    console.log("[Test 1/4] Testing ATS Classifier URL Recognition...");

    const urlTestCases = [
        { url: "https://boards.greenhouse.io/acme/jobs/123456", expected: "GREENHOUSE" },
        { url: "https://jobs.lever.co/acmecorp/fe45-ab23", expected: "LEVER" },
        { url: "https://jobs.smartrecruiters.com/AcmeInc/98765", expected: "SMARTRECRUITERS" },
        { url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Bangalore/DevOps_R123", expected: "WORKDAY" },
        { url: "https://jobs.ashbyhq.com/acme/abc123", expected: "ASHBY" },
        { url: "https://career4.successfactors.com/sfcareer/jobreqcareer?jobId=1001", expected: "SUCCESSFACTORS" },
        { url: "https://fa-abcd-dev.oraclecloud.com/hrcUI/CandidateExperience/en/sites/CX/job/5001", expected: "ORACLE_RECRUITING" },
        { url: "https://careers.company.com/apply/devops-engineer", expected: "COMPANY_SITE" }
    ];

    for (const tc of urlTestCases) {
        const res = await atsClassifier.classify(null, tc.url);
        console.log(`  URL: ${tc.url.substring(0, 45)}... -> Classified: ${res.ats} (Expected: ${tc.expected})`);
        assert.strictEqual(res.ats, tc.expected, `Classification mismatch for URL: ${tc.url}`);
    }
    console.log("✓ Test 1 Passed: All ATS URL classifications match expected types.\n");

    // Test 2: External Application Router Adapter Selection
    console.log("[Test 2/4] Testing Adapter Router Mapping...");
    const atsTypes = ["GREENHOUSE", "LEVER", "SMARTRECRUITERS", "WORKDAY", "ASHBY", "SUCCESSFACTORS", "ORACLE_RECRUITING", "COMPANY_SITE", "UNKNOWN_EXTERNAL"];
    for (const ats of atsTypes) {
        const adapter = externalApplicationRouter.getAdapter(ats);
        assert.ok(adapter, `Adapter should exist for ATS: ${ats}`);
        console.log(`  ATS: ${ats.padEnd(20)} -> Adapter: ${adapter.atsName}`);
    }
    console.log("✓ Test 2 Passed: Adapter router maps every ATS to valid adapter.\n");

    // Test 3: Questionnaire Engine Candidate Knowledge Resolution
    console.log("[Test 3/4] Testing Questionnaire Engine Question Resolution...");
    const mockProfile = {
        firstName: "Jawad",
        lastName: "Koroth",
        fullName: "Jawad Koroth",
        email: "jawad@gmail.com",
        phone: "9876543210",
        linkedinUrl: "https://linkedin.com/in/jawadkoroth",
        totalExperience: "6",
        currentCTC: "18 LPA",
        expectedCTC: "25 LPA",
        noticePeriod: "30 days"
    };

    const q1 = await questionnaireEngine.resolveQuestion("First Name", mockProfile);
    assert.strictEqual(q1.resolved, true);
    assert.ok(q1.answer.length > 0);

    const q2 = await questionnaireEngine.resolveQuestion("Email Address", mockProfile);
    assert.strictEqual(q2.resolved, true);
    assert.ok(q2.answer.includes("@"));

    const q3 = await questionnaireEngine.resolveQuestion("Expected Salary / CTC", mockProfile);
    assert.strictEqual(q3.resolved, true);
    assert.ok(q3.answer.length > 0);

    console.log("✓ Test 3 Passed: QuestionnaireEngine correctly resolves candidate facts.\n");

    // Test 4: Safety Gate on Unresolved Required Questions
    console.log("[Test 4/4] Testing Safety Gate for Unresolved Required Questions...");
    const unknownQ = await questionnaireEngine.resolveQuestion("What is your favourite quantum computing algorithm?", mockProfile);
    assert.strictEqual(unknownQ.resolved, false);
    assert.strictEqual(unknownQ.reason, "NO_MATCHING_KNOWLEDGE");
    console.log(`  Unknown Question Resolution: resolved=${unknownQ.resolved}, reason=${unknownQ.reason}`);

    console.log("✓ Test 4 Passed: Safety gate prevents guessing unknown questions.\n");

    console.log("==================================================");
    console.log("ALL SYNTHETIC UNIT TESTS PASSED CLEANLY!");
    console.log("==================================================");
})();
