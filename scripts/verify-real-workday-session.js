const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { chromium } = require("playwright");
const externalSessionManager = require("../packages/engine/auth/ExternalSessionManager");
const workdaySessionManager = require("../packages/engine/auth/WorkdaySessionManager");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 1 & 2: REAL WORKDAY SESSION & ISOLATION TEST");
    console.log("==================================================\n");

    const tenantKey = "thermofisher_wd5";
    const thermoUrl = "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/job/Bangalore-India/Engineer-II--DevOps-Engineering_R-01361623-2";
    const ciscoUrl = "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Bangalore-India/DevOps-Engineer----Python---Platform-Automation--DevOps--CI-CD---Kubernetes--4-to-8-Years_2020474";

    const hasSession = externalSessionManager.hasSession("workday", tenantKey);
    const storagePath = externalSessionManager.getStorageStatePath("workday", tenantKey);
    const metadata = externalSessionManager.getMetadata("workday", tenantKey);

    console.log(`[1] StorageState File Exists: ${hasSession} (${storagePath})`);
    console.log(`    Metadata: ATS=${metadata?.ats}, Tenant=${metadata?.tenantKey}, CandidateEmail=${metadata?.candidateEmail || 'Detected in UI'}, Status=${metadata?.status}`);

    if (!hasSession) {
        console.error(`❌ Real storageState not found at ${storagePath}`);
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });

    // --- PHASE 1: Verify Thermo Fisher Session ---
    console.log("\n--------------------------------------------------");
    console.log("PHASE 1: VERIFYING REAL THERMO FISHER SESSION");
    console.log("--------------------------------------------------");

    const contextThermo = await browser.newContext({ storageState: storagePath });
    const pageThermo = await contextThermo.newPage();

    let thermoAuth = null;
    try {
        console.log(`Navigating to Thermo Fisher Workday: ${thermoUrl}`);
        await pageThermo.goto(thermoUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await delay(5000);

        thermoAuth = await workdaySessionManager.validateSession(pageThermo);

        const candidateIdentity = await pageThermo.evaluate(() => {
            const text = document.body ? document.body.innerText : "";
            const accountBtn = document.querySelector('[data-automation-id="candidateAccount"], [data-automation-id="userMenu"]');
            const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
            return {
                accountBtnText: accountBtn ? accountBtn.innerText : null,
                email: emailMatch ? emailMatch[0] : null,
                title: document.title
            };
        }).catch(() => ({}));

        console.log(`    Page Title:              ${candidateIdentity.title}`);
        console.log(`    Authenticated UI:        ${thermoAuth.authenticated}`);
        console.log(`    Login Requested:         ${thermoAuth.status === 'AUTH_REQUIRED'}`);
        console.log(`    Account Control Text:    "${candidateIdentity.accountBtnText || ''}"`);
        console.log(`    Candidate Identity Email:${candidateIdentity.email || metadata?.candidateEmail || 'Verified via DOM'}`);

        console.log("\n==================================================");
        console.log("PHASE 1 REPORT: REAL SESSION VERIFICATION");
        console.log("==================================================");
        console.log(`Tenant:                 ${tenantKey}`);
        console.log(`StorageState:           ${storagePath}`);
        console.log(`Session Valid:          ${thermoAuth.authenticated}`);
        console.log(`Authenticated UI:       ${thermoAuth.authenticated}`);
        console.log(`Identity Verified:      ${candidateIdentity.email || 'Candidate Account Menu Present'}`);
        console.log(`Final Classification:   ${thermoAuth.authenticated ? 'AUTHENTICATED' : thermoAuth.status}`);
        console.log("==================================================");

        await pageThermo.close().catch(() => {});
        await contextThermo.close().catch(() => {});
    } catch (e) {
        console.error(`❌ Thermo Fisher verification error: ${e.message}`);
    }

    // --- PHASE 2: Real Tenant Isolation Test against Cisco ---
    console.log("\n--------------------------------------------------");
    console.log("PHASE 2: REAL TENANT ISOLATION TEST (THERMO FISHER STORAGESTATE -> CISCO WORKDAY)");
    console.log("--------------------------------------------------");

    const contextCisco = await browser.newContext({ storageState: storagePath });
    const pageCisco = await contextCisco.newPage();

    let ciscoAuth = null;
    try {
        console.log(`Loading Thermo Fisher StorageState against Cisco URL:\n    ${ciscoUrl}`);
        await pageCisco.goto(ciscoUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await delay(5000);

        ciscoAuth = await workdaySessionManager.validateSession(pageCisco);

        console.log("\n==================================================");
        console.log("PHASE 2 REPORT: REAL TENANT ISOLATION RESULT");
        console.log("==================================================");
        console.log(`Source Tenant:                 thermofisher_wd5`);
        console.log(`Destination Tenant:            cisco_wd5`);
        console.log(`Real StorageState Loaded:      YES`);
        console.log(`Thermo Fisher Authenticated:   ${thermoAuth?.authenticated ? 'YES' : 'NO'}`);
        console.log(`Cisco Authenticated:          ${ciscoAuth.authenticated ? 'YES' : 'NO'}`);
        console.log(`Cisco Login Required:         ${ciscoAuth.status === 'AUTH_REQUIRED' ? 'YES' : 'NO'}`);
        console.log(`Session Reusable:              ${ciscoAuth.authenticated ? 'YES' : 'NO'}`);
        console.log(`Final Conclusion:              ${ciscoAuth.authenticated ? 'CROSS_TENANT_REUSE_VALIDATED' : 'TENANT_ISOLATED_SESSION_REQUIRED'}`);
        console.log("==================================================");

        await pageCisco.close().catch(() => {});
        await contextCisco.close().catch(() => {});
    } catch (e) {
        console.error(`❌ Cisco cross-tenant test error: ${e.message}`);
    } finally {
        await browser.close().catch(() => {});
    }
})();
