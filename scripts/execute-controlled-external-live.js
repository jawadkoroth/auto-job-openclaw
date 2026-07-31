const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const externalApplicationEngine = require("../packages/engine/ExternalApplicationEngine");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const oraclePersistence = require("../packages/persistence/NaukriOraclePersistence");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("NAUKRI CONTROLLED LIVE EXTERNAL APPLICATION EXECUTION");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context, page: discoveryPage } = boot;
    await db.init();
    const candidateProfile = await candidateProfileService.getProfile().catch(() => ({}));

    try {
        console.log("[1/4] Discovering external candidate job...");
        const searchUrl = "https://www.naukri.com/devops-jobs-in-bangalore";
        await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        const cards = discoveryPage.locator(".cust-job-tuple, article.jobTuple, div.srp-jobtuple, article.srp-jobtuple");
        const count = await cards.count().catch(() => 0);

        let targetJob = null;
        for (let i = 0; i < count; i++) {
            const item = cards.nth(i);
            const cardText = (await item.textContent().catch(() => "")).toLowerCase();
            const isExt = cardText.includes("company site") || cardText.includes("external");

            const titleLoc = item.locator("a.title, .title, [class*='title']").first();
            const title = (await titleLoc.textContent().catch(() => "")).trim();
            const url = await titleLoc.getAttribute("href").catch(() => "");
            const compLoc = item.locator(".companyName, .company, [class*='company']").first();
            const company = (await compLoc.textContent().catch(() => "Company")).trim();

            let jobId = await item.getAttribute("data-job-id").catch(() => null);
            if (!jobId && url) {
                const match = url.match(/-([0-9]{12})\b/);
                if (match) jobId = match[1];
                else jobId = url.split("?")[0].split("/").pop();
            }
            if (!jobId) jobId = `naukri_live_${Date.now()}`;

            // Check if already applied
            const isDup = await oraclePersistence.isDuplicateJob(jobId, url);
            if (isDup) continue;

            targetJob = {
                id: jobId,
                job_id: jobId,
                title,
                role: title,
                company,
                url,
                apply_link: url,
                portal: "naukri",
                isExternal: isExt,
                applyType: isExt ? "EXTERNAL" : "NATIVE"
            };
            break;
        }

        if (!targetJob) {
            console.log("No unapplied job candidate found in search. Exiting gracefully.");
            await discoveryPage.close();
            await context.close();
            await browser.close();
            process.exit(0);
        }

        console.log(`[2/4] Selected Candidate Job ID: ${targetJob.id}`);
        console.log(`      Title:      ${targetJob.title}`);
        console.log(`      Company:    ${targetJob.company}`);
        console.log(`      Naukri URL: ${targetJob.url}`);
        console.log(`      Type:       ${targetJob.isExternal ? 'EXTERNAL COMPANY SITE' : 'NATIVE / GENERAL'}`);

        console.log("\n[3/4] Processing job application via ExternalApplicationEngine...");
        const jobPage = await context.newPage();
        await jobPage.goto(targetJob.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        const extResult = await externalApplicationEngine.processExternalJob({
            naukriPage: jobPage,
            context,
            job: targetJob,
            candidateProfile,
            isDryRun: false
        });

        console.log("\n==================================================");
        console.log("PHASE 12 ACCEPTANCE REPORT: CONTROLLED LIVE APPLICATION");
        console.log("==================================================");
        console.log(`Company:                        ${targetJob.company}`);
        console.log(`Role:                           ${targetJob.title}`);
        console.log(`Naukri Job ID:                  ${targetJob.id}`);
        console.log(`Naukri URL:                     ${targetJob.url}`);
        console.log(`External ATS:                   ${extResult.ats}`);
        console.log(`External URL:                   ${extResult.externalUrl}`);
        console.log(`Application status:             ${extResult.status}`);
        console.log(`Applied flag:                   ${extResult.applied}`);
        console.log(`Reason / Details:               ${extResult.reason || 'None'}`);

        const oracleCheck = await oraclePersistence._makeRequest("GET", `/api/naukri/job-status?jobId=${encodeURIComponent(targetJob.id)}`).catch(() => null);
        console.log(`Oracle State:                   ${oracleCheck?.job ? `${oracleCheck.job.status} (applied: ${oracleCheck.job.applied})` : 'PERSISTED_TO_OUTBOX_OR_API'}`);

        const finalClassification = extResult.applied === 1 && extResult.status === 'EMPLOYER_PENDING'
            ? 'VERIFIED_EXTERNAL_APPLICATION'
            : (extResult.status === 'WAITING_FOR_INPUT' ? 'WAITING_FOR_INPUT' : extResult.status);

        console.log(`\nFINAL CLASSIFICATION:          ${finalClassification}`);
        console.log("==================================================");

        await jobPage.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Controlled live test exception: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await oraclePersistence.flushOutbox().catch(() => {});
    }
})();
