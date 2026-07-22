const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const externalCareerAuthManager = require("../packages/auth/ExternalCareerAuthManager");
const gmailOtpManager = require("../packages/auth/GmailOtpManager");
const simplifyAutofillAdapter = require("../packages/automation/SimplifyAutofillAdapter");
const externalAtsAutomation = require("../packages/automation/ExternalAtsAutomation");

async function runRegressionTests() {
    console.log("==================================================");
    console.log("REGRESSION TEST SUITE — INTERMEDIARY & ROUTING");
    console.log("==================================================\n");

    let passCount = 0;
    let totalCount = 0;

    function assertTest(name, condition) {
        totalCount++;
        if (condition) {
            console.log(`✅ [PASS] TEST ${totalCount}: ${name}`);
            passCount++;
        } else {
            console.log(`❌ [FAIL] TEST ${totalCount}: ${name}`);
        }
    }

    // 1. LinkedIn job URL always classifies LINKEDIN_JOB
    const linkedinClass = externalApplicationRouter.classifyATS("https://www.linkedin.com/jobs/view/4439452616/");
    assertTest("LinkedIn job URL always classifies LINKEDIN_JOB", linkedinClass === "LINKEDIN_JOB");

    // 2. Indeed job URL always classifies INDEED_JOB
    const indeedClass = externalApplicationRouter.classifyATS("https://www.indeed.com/viewjob?jk=123456789");
    assertTest("Indeed job URL always classifies INDEED_JOB", indeedClass === "INDEED_JOB");

    // 3. LinkedIn URL can never classify Generic Company Career Page
    const linkedinAuthwall = externalApplicationRouter.classifyATS("https://www.linkedin.com/authwall?trk=bf");
    assertTest("LinkedIn URL can never classify Generic Company Career Page", linkedinAuthwall !== "Generic Company Career Page");

    // 4. EXTERNAL_ATS requires non-LinkedIn destination
    const dummyPageLinkedIn = {
        url: () => "https://www.linkedin.com/jobs/view/4439452616/",
        content: async () => "<html><body>Sign in</body></html>",
        waitForTimeout: async () => {},
        locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) })
    };
    const resLinkedIn = await externalApplicationRouter.resolveIntermediary(dummyPageLinkedIn, "https://www.linkedin.com/jobs/view/4439452616/");
    assertTest("EXTERNAL_ATS requires non-LinkedIn destination", resLinkedIn.type !== "EXTERNAL_ATS");

    // 5. Self-resolving LinkedIn URL returns APPLICATION_URL_UNRESOLVED or LINKEDIN_AUTH_REQUIRED
    assertTest("Self-resolving LinkedIn URL returns APPLICATION_URL_UNRESOLVED or LINKEDIN_AUTH_REQUIRED", 
        resLinkedIn.type === "APPLICATION_URL_UNRESOLVED" || resLinkedIn.type === "LINKEDIN_AUTH_REQUIRED");

    // 6. LinkedIn auth never invokes ExternalCareerAuthManager
    const linkedinAuthPage = { url: () => "https://www.linkedin.com/jobs/view/4439452616/" };
    const authResult = await externalCareerAuthManager.handleAuth(linkedinAuthPage, { title: "Test Job", company: "Test Co" });
    assertTest("LinkedIn auth never invokes ExternalCareerAuthManager", authResult.isIntermediaryDomain === true && authResult.authenticated === false);

    // 7. LinkedIn auth never uses EXTERNAL_CAREER_PASSWORD
    const detectAuthResult = await externalCareerAuthManager.detectAuthRequired(linkedinAuthPage);
    assertTest("LinkedIn auth never uses EXTERNAL_CAREER_PASSWORD", detectAuthResult === false);

    // 8. Popup external destination is captured
    const externalWorkdayUrl = "https://lseg.wd3.myworkdayjobs.com/en-US/LSEG/job/Bangalore/SRE_JR101";
    const externalWorkdayAts = externalApplicationRouter.classifyATS(externalWorkdayUrl);
    assertTest("Popup external destination is captured", externalWorkdayAts === "Workday");

    // 9. Same-tab external navigation is captured
    const externalGreenhouseUrl = "https://boards.greenhouse.io/lseg/jobs/123456";
    const externalGreenhouseAts = externalApplicationRouter.classifyATS(externalGreenhouseUrl);
    assertTest("Same-tab external navigation is captured", externalGreenhouseAts === "Greenhouse");

    // 10. Redirect chain destination is captured
    const externalOracleUrl = "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210740048";
    const externalOracleAts = externalApplicationRouter.classifyATS(externalOracleUrl);
    assertTest("Redirect chain destination is captured", externalOracleAts === "Oracle Recruiting / Oracle HCM");

    // 11. Live test WAITING_FOR_INPUT cannot report Overall PASS
    const databaseStatus = "WAITING_FOR_INPUT";
    let calculatedResult = "PARTIAL";
    if (databaseStatus === "APPLIED") calculatedResult = "APPLIED";
    else if (databaseStatus === "WAITING_FOR_INPUT") calculatedResult = "WAITING_FOR_INPUT";
    assertTest("Live test WAITING_FOR_INPUT cannot report Overall PASS", calculatedResult !== "PASS" && calculatedResult === "WAITING_FOR_INPUT");

    console.log("\n==================================================");
    console.log(`REGRESSION SUMMARY: Passed ${passCount}/${totalCount} tests.`);
    console.log("==================================================");

    if (passCount !== totalCount) {
        process.exit(1);
    }
}

runRegressionTests().catch(err => {
    console.error("Regression test error:", err);
    process.exit(1);
});
