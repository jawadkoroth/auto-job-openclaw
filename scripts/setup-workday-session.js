const path = require("path");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const externalSessionManager = require("../packages/engine/auth/ExternalSessionManager");
const workdaySessionManager = require("../packages/engine/auth/WorkdaySessionManager");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targetArg = process.argv[2] || "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/job/Bangalore-India/Engineer-II--DevOps-Engineering_R-01361623-2";

(async () => {
    console.log("==================================================");
    console.log("MANUAL WORKDAY CANDIDATE SESSION BOOTSTRAP (HEADED)");
    console.log("==================================================\n");

    const tenantKey = workdaySessionManager.getTenantKey(targetArg);
    console.log(`[1] Target Workday URL: ${targetArg}`);
    console.log(`[2] Derived Tenant Key: ${tenantKey}`);

    console.log("\n[3] Launching headed Chromium browser on Windows...");
    console.log("    👉 PLEASE SIGN IN MANUALLY IN THE OPENED BROWSER WINDOW.");
    console.log("    👉 Complete any required Account Creation, OTP, MFA, or CAPTCHA.");
    console.log("    👉 The automation WILL NOT auto-fill passwords or bypass security checks.\n");

    const browser = await chromium.launch({
        headless: false,
        args: ["--start-maximized"]
    });

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    try {
        await page.goto(targetArg, { waitUntil: "domcontentloaded", timeout: 45000 });
        await delay(3000);

        // Click Sign In button if visible to navigate to sign in page
        const signInBtn = page.locator('a[data-automation-id="signIn"], button[data-automation-id="signIn"], a:has-text("Sign In")').first();
        if (await signInBtn.count().catch(() => 0) > 0 && await signInBtn.isVisible().catch(() => false)) {
            console.log("    Navigating to Workday Sign In page...");
            await signInBtn.click().catch(() => {});
        }

        console.log("    Waiting for candidate authentication completion (Polling for 'Sign Out' / Candidate Account UI)...");

        let isAuthenticated = false;
        let candidateEmail = null;
        const maxWaitMs = 300000; // 5 minutes max wait for manual login
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
            const check = await workdaySessionManager.validateSession(page);
            if (check.authenticated) {
                isAuthenticated = true;
                candidateEmail = check.candidateEmail;
                console.log(`\n✓ SUCCESSFUL AUTHENTICATED WORKDAY CANDIDATE STATE DETECTED!`);
                console.log(`  Candidate Email: ${candidateEmail || 'Detected in Candidate UI'}`);
                break;
            }
            await delay(3000);
        }

        if (!isAuthenticated) {
            console.error("\n❌ Manual authentication timeout reached (5 mins). Session export cancelled.");
            await browser.close();
            process.exit(1);
        }

        console.log("\n[4] Exporting Playwright storageState...");
        const saved = await externalSessionManager.saveSession({
            ats: "workday",
            tenantKey,
            context,
            candidateEmail,
            careerHost: new URL(targetArg).hostname
        });

        if (saved) {
            console.log("\n==================================================");
            console.log("WORKDAY SESSION BOOTSTRAP COMPLETE!");
            console.log(`Session Path: ${externalSessionManager.getStorageStatePath('workday', tenantKey)}`);
            console.log("==================================================");
        }

    } catch (err) {
        console.error(`❌ Session bootstrap error: ${err.message}`);
    } finally {
        await delay(2000);
        await browser.close().catch(() => {});
    }
})();
