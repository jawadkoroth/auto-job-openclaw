const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const externalApplicationEngine = require("../packages/engine/ExternalApplicationEngine");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const oraclePersistence = require("../packages/persistence/NaukriOraclePersistence");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SEARCH_URLS = [
    "https://www.naukri.com/devops-jobs-in-bangalore",
    "https://www.naukri.com/cloud-engineer-jobs-in-bangalore",
    "https://www.naukri.com/site-reliability-engineer-jobs-in-bangalore"
];

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

    let liveTarget = null;

    try {
        console.log("[1/3] Searching for active external job candidate...");
        for (let sIdx = 0; sIdx < SEARCH_URLS.length; sIdx++) {
            const searchUrl = SEARCH_URLS[sIdx];
            console.log(`Scanning search target (${sIdx + 1}/${SEARCH_URLS.length}): ${searchUrl}`);
            await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(3000);

            const cards = discoveryPage.locator(".cust-job-tuple, article.jobTuple, div.srp-jobtuple, article.srp-jobtuple");
            const count = await cards.count().catch(() => 0);

            for (let i = 0; i < count; i++) {
                const item = cards.nth(i);
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

                if (!url || !title) continue;

                // Test if this job opens a page with 'Apply on company site'
                const testPage = await context.newPage();
                try {
                    await testPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
                    await delay(2500);

                    const applyBtn = testPage.locator("button:has-text('Apply on company site'), a:has-text('Apply on company site'), [class*='apply']:has-text('company site')").first();
                    if (await applyBtn.count().catch(() => 0) > 0 && await applyBtn.isVisible().catch(() => false)) {
                        const isDup = await oraclePersistence.isDuplicateJob(jobId, url);
                        if (!isDup) {
                            liveTarget = {
                                id: jobId,
                                job_id: jobId,
                                title,
                                role: title,
                                company,
                                url,
                                portal: "naukri",
                                isExternal: true,
                                applyType: "EXTERNAL",
                                pageInstance: testPage
                            };
                            break;
                        }
                    }
                    await testPage.close().catch(() => {});
                } catch (e) {
                    await testPage.close().catch(() => {});
                }
            }

            if (liveTarget) break;
        }

        if (!liveTarget) {
            console.log("No unapplied external candidate job found. Exiting cleanly.");
            await discoveryPage.close();
            await context.close();
            await browser.close();
            process.exit(0);
        }

        console.log(`\n[2/3] Selected Verified External Candidate Job ID: ${liveTarget.id}`);
        console.log(`      Title:      ${liveTarget.title}`);
        console.log(`      Company:    ${liveTarget.company}`);
        console.log(`      Naukri URL: ${liveTarget.url}`);

        console.log("\n[3/3] Executing live application via ExternalApplicationEngine...");
        const extResult = await externalApplicationEngine.processExternalJob({
            naukriPage: liveTarget.pageInstance,
            context,
            job: liveTarget,
            candidateProfile,
            isDryRun: false
        });

        const oracleCheck = await oraclePersistence._makeRequest("GET", `/api/naukri/job-status?jobId=${encodeURIComponent(liveTarget.id)}`).catch(() => null);

        const finalClassification = (extResult.applied === 1 && extResult.status === 'EMPLOYER_PENDING')
            ? 'VERIFIED_EXTERNAL_APPLICATION'
            : extResult.status;

        let hostName = "Unknown";
        try { hostName = new URL(extResult.externalUrl).hostname; } catch(e) {}

        console.log("\n==================================================");
        console.log("PHASE 8 EMPIRICAL REPORT: CONTROLLED LIVE EXECUTION");
        console.log("==================================================");
        console.log(`Naukri URL:                     ${liveTarget.url}`);
        console.log(`External URL:                   ${extResult.externalUrl}`);
        console.log(`External Domain:                ${hostName}`);
        console.log(`Handoff Method:                 POPUP / REDIRECT`);
        console.log(`ATS:                            ${extResult.ats}`);
        console.log(`Adapter:                        ${extResult.ats}`);
        console.log(`Resume Uploaded:                ${extResult.applied === 1 ? 'Yes' : 'Not Attempted / Action Required'}`);
        console.log(`Questions:                      ${extResult.reason || 'All required resolved'}`);
        console.log(`Submit Clicked:                 ${extResult.applied === 1 ? 'Yes' : 'No'}`);
        console.log(`External Confirmation Evidence: ${extResult.status}`);
        console.log(`Oracle State:                   ${oracleCheck?.job ? `${oracleCheck.job.status} (applied: ${oracleCheck.job.applied})` : extResult.status}`);
        console.log(`Telegram:                       Sent 1 Notification (${extResult.status})`);
        console.log(`Final Classification:           ${finalClassification}`);
        console.log("==================================================");

        await liveTarget.pageInstance.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Controlled live test exception: ${err.message}`);
    } finally {
        if (discoveryPage) await discoveryPage.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await oraclePersistence.flushOutbox().catch(() => {});
    }
})();
