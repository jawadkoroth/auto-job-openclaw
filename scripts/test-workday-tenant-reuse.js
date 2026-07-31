const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { chromium } = require("playwright");
const externalSessionManager = require("../packages/engine/auth/ExternalSessionManager");
const workdaySessionManager = require("../packages/engine/auth/WorkdaySessionManager");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 16E: WORKDAY TENANT SESSION REUSE TEST");
    console.log("==================================================\n");

    const sourceTenant = "thermofisher_wd5";
    const sourceUrl = "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/job/Bangalore-India/Engineer-II--DevOps-Engineering_R-01361623-2";
    const destTenant = "cisco_wd5";
    const destUrl = "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Bangalore-India/DevOps-Engineer----Python---Platform-Automation--DevOps--CI-CD---Kubernetes--4-to-8-Years_2020474";

    const hasSourceSession = externalSessionManager.hasSession("workday", sourceTenant);
    console.log(`[1] Source Session Exists (${sourceTenant}): ${hasSourceSession}`);

    const browser = await chromium.launch({ headless: true });
    let contextOptions = {};
    if (hasSourceSession) {
        contextOptions.storageState = externalSessionManager.getStorageStatePath("workday", sourceTenant);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        console.log(`[2] Loading Source Session on Destination Workday Tenant:\n    Destination: ${destUrl}`);
        await page.goto(destUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(4000);

        const check = await workdaySessionManager.validateSession(page);

        console.log("\n==================================================");
        console.log("WORKDAY TENANT SESSION REUSE REPORT:");
        console.log("==================================================");
        console.log(`Source Tenant:                 ${sourceTenant}`);
        console.log(`Destination Tenant:            ${destTenant}`);
        console.log(`StorageState Loaded:           ${hasSourceSession ? 'Yes' : 'No (Synthetic mock session)'}`);
        console.log(`Authenticated Candidate UI:    ${check.authenticated}`);
        console.log(`Login Required:                ${check.status === 'AUTH_REQUIRED'}`);
        console.log(`Session Reusable:              ${check.authenticated}`);
        console.log(`Result:                        ${check.authenticated ? 'CROSS_TENANT_REUSE_SUPPORTED' : 'TENANT_ISOLATED_SESSION_REQUIRED'}`);
        console.log("==================================================");

        await page.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Tenant reuse test exception: ${err.message}`);
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
})();
