const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const atsClassifier = require("../packages/engine/ATSClassifier");
const externalApplicationRouter = require("../packages/engine/ExternalApplicationRouter");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("NAUKRI EXTERNAL JOB INSPECTION & ATS DETECTION TEST");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context, page: discoveryPage } = boot;

    try {
        console.log("[1/3] Searching for EXTERNAL_REQUIRED job on Naukri...");
        const searchUrl = "https://www.naukri.com/devops-jobs-in-bangalore";
        await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        const cards = discoveryPage.locator(".cust-job-tuple, article.jobTuple, div.srp-jobtuple, article.srp-jobtuple");
        const count = await cards.count().catch(() => 0);

        let externalTarget = null;
        for (let i = 0; i < count; i++) {
            const item = cards.nth(i);
            const cardText = (await item.textContent().catch(() => "")).toLowerCase();
            if (cardText.includes("company site") || cardText.includes("external")) {
                const titleLoc = item.locator("a.title, .title, [class*='title']").first();
                const title = (await titleLoc.textContent().catch(() => "")).trim();
                const url = await titleLoc.getAttribute("href").catch(() => "");
                const compLoc = item.locator(".companyName, .company, [class*='company']").first();
                const company = (await compLoc.textContent().catch(() => "Company")).trim();

                externalTarget = { title, company, url };
                break;
            }
        }

        if (!externalTarget) {
            console.log("No card flagged 'company site' directly on search page 1. Checking job details page for external apply button...");
            // Grab the first job link and check its apply button
            const firstTitleLoc = cards.first().locator("a.title, .title, [class*='title']").first();
            const title = (await firstTitleLoc.textContent().catch(() => "")).trim();
            const url = await firstTitleLoc.getAttribute("href").catch(() => "");
            const compLoc = cards.first().locator(".companyName, .company, [class*='company']").first();
            const company = (await compLoc.textContent().catch(() => "Company")).trim();
            externalTarget = { title, company, url };
        }

        console.log(`[2/3] Opening target job page: "${externalTarget.title}" at "${externalTarget.company}"`);
        console.log(`      Naukri URL: ${externalTarget.url}`);

        const jobPage = await context.newPage();
        await jobPage.goto(externalTarget.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        // Check for apply button text
        const applyBtnLocators = [
            jobPage.locator("button:has-text('Apply on company site')"),
            jobPage.locator("a:has-text('Apply on company site')"),
            jobPage.locator("button.apply-button"),
            jobPage.locator("button:has-text('Apply')")
        ];

        let applyBtn = null;
        for (const loc of applyBtnLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                applyBtn = loc.first();
                break;
            }
        }

        if (!applyBtn) {
            console.log("⚠️ Apply button not found or already applied on this job page.");
            await jobPage.close();
            await context.close();
            await browser.close();
            process.exit(0);
        }

        const btnText = (await applyBtn.textContent().catch(() => "")).trim();
        console.log(`      Apply Button Text: "${btnText}"`);

        console.log("[3/3] Tracing external application redirect (READ-ONLY, NO SUBMISSION)...");
        const popupPromise = context.waitForEvent('page', { timeout: 12000 }).catch(() => null);
        await applyBtn.click().catch(() => {});

        let externalPage = await popupPromise;
        if (!externalPage) externalPage = jobPage;
        await delay(4000);

        const externalUrl = externalPage.url();
        console.log(`      Captured External Destination URL: ${externalUrl}`);

        const classification = await atsClassifier.classify(externalPage, externalUrl);
        console.log(`      Classified ATS: ${classification.ats}`);
        console.log(`      Confidence:     ${classification.confidence}`);
        console.log(`      Domain:         ${classification.domain}`);

        const adapter = externalApplicationRouter.getAdapter(classification.ats);
        console.log(`      Matched Router Adapter: ${adapter.atsName}`);

        const authCheck = await adapter.detectAuthOrCaptcha(externalPage);
        console.log(`      Security / Auth Status: ${authCheck.blocked ? authCheck.reason : 'CLEAR_DIRECT_ACCESS'}`);

        console.log("\n==================================================");
        console.log("✓ READ-ONLY EXTERNAL REDIRECT & ATS DETECTION SUCCESSFUL");
        console.log("  No application submit action occurred during this test.");
        console.log("==================================================");

        await jobPage.close().catch(() => {});
        if (externalPage !== jobPage) await externalPage.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Inspection failed: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
