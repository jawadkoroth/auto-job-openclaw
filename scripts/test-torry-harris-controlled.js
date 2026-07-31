const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const genericFormAdapter = require("../packages/engine/adapters/GenericFormAdapter");
const questionnaireEngine = require("../packages/engine/QuestionnaireEngine");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 10: TORRY HARRIS CONTROLLED FORM_READY AUDIT");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context } = boot;
    await db.init();
    const candidateProfile = await candidateProfileService.getProfile().catch(() => ({}));

    const directExternalUrl = "https://careers.torryharris.com/torryharris/jobview/aws-cloud-and-devops-engineer-bangalore-karnataka-india-2026072314545284?source=naukri";

    try {
        console.log(`[1] Navigating to Torry Harris External URL:\n    ${directExternalUrl}`);
        const extPage = await context.newPage();
        await extPage.goto(directExternalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);

        console.log("\n[2] Executing GenericFormAdapter state machine & form discovery...");
        const fillResult = await genericFormAdapter.fillForm(extPage, candidateProfile, questionnaireEngine);

        console.log("\n==================================================");
        console.log("PHASE 10 REPORT: TORRY HARRIS FORM_READY AUDIT");
        console.log("==================================================");
        console.log(`External Domain:                ${new URL(directExternalUrl).hostname}`);
        console.log(`Application Stage:             ${fillResult.status}`);
        console.log(`Reason Code:                    ${fillResult.reasonCode}`);
        console.log(`Details:                        ${fillResult.details}`);
        console.log(`Resume Required:                Yes`);
        console.log(`FORM_READY:                     ${fillResult.status === 'FORM_READY'}`);
        console.log(`Final Classification:           ${fillResult.status}`);
        console.log("==================================================");

        await extPage.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Phase 10 test exception: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
