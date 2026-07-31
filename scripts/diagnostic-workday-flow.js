const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const atsClassifier = require("../packages/engine/ATSClassifier");
const workdayAdapter = require("../packages/engine/adapters/WorkdayAdapter");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 9 WORKDAY READ-ONLY INSPECTION: DIRECT CISCO WORKDAY PORTAL");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context } = boot;
    const directWorkdayUrl = "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Bangalore-India/DevOps-Engineer----Python---Platform-Automation--DevOps--CI-CD---Kubernetes--4-to-8-Years_2020474";

    try {
        console.log(`[1] Navigating directly to Cisco Workday URL:\n    ${directWorkdayUrl}`);
        const extPage = await context.newPage();
        await extPage.goto(directWorkdayUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);

        const classification = await atsClassifier.classify(extPage, extPage.url());
        console.log(`[2] Classified ATS: ${classification.ats} (Domain: ${classification.domain})`);

        const authCheck = await workdayAdapter.detectAuthOrCaptcha(extPage);
        console.log(`[3] Auth / Security Check: ${authCheck.blocked ? `${authCheck.reason} (${authCheck.details})` : 'CLEAR'}`);

        const pageDetails = await extPage.evaluate(() => {
            const text = document.body ? document.body.innerText : "";
            const applyBtns = Array.from(document.querySelectorAll('a, button'))
                .map(b => (b.innerText || b.getAttribute('data-automation-id') || '').trim())
                .filter(b => b.toLowerCase().includes('apply') || b.toLowerCase().includes('sign in'));

            const hasPasswords = document.querySelectorAll('input[type="password"]').length;
            const automationAttrs = document.querySelectorAll('[data-automation-id]').length;

            return {
                title: document.title,
                applyBtns,
                hasPasswords,
                automationAttrs,
                snippet: text.substring(0, 300).replace(/\s+/g, ' ')
            };
        }).catch(() => null);

        console.log("    Page Title:              ", pageDetails?.title);
        console.log("    Text Snippet:            ", pageDetails?.snippet);
        console.log("    Automation Attrs Count:  ", pageDetails?.automationAttrs);
        console.log("    Password Inputs Count:   ", pageDetails?.hasPasswords);
        console.log("    Apply / Sign-In Buttons: ", pageDetails?.applyBtns);

        // Click "Apply" button on Workday if available
        const applyBtn = extPage.locator('a[data-automation-id="adventureButton"], button[data-automation-id="applyButton"], a:has-text("Apply")').first();
        if (await applyBtn.count().catch(() => 0) > 0 && await applyBtn.isVisible().catch(() => false)) {
            console.log("\n[4] Clicking Workday Apply button...");
            await applyBtn.click().catch(() => {});
            await delay(4000);

            const postClickAuth = await workdayAdapter.detectAuthOrCaptcha(extPage);
            console.log(`    Post-Apply Click Auth / Security: ${postClickAuth.blocked ? `${postClickAuth.reason} (${postClickAuth.details})` : 'CLEAR'}`);
            console.log(`    Post-Apply URL: ${extPage.url()}`);
        }

        console.log("\n==================================================");
        console.log("✓ PHASE 9 WORKDAY READ-ONLY INSPECTION COMPLETE");
        console.log("==================================================");

        await extPage.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Workday inspection exception: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
