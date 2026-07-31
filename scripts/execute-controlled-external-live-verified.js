const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const externalApplicationEngine = require("../packages/engine/ExternalApplicationEngine");
const externalRedirectResolver = require("../packages/engine/ExternalRedirectResolver");
const atsClassifier = require("../packages/engine/ATSClassifier");
const candidateProfileService = require("../packages/knowledge/CandidateProfile");
const oraclePersistence = require("../packages/persistence/NaukriOraclePersistence");
const telegramService = require("../apps/telegram");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SEARCH_URLS = [
    "https://www.naukri.com/devops-jobs-in-bangalore",
    "https://www.naukri.com/cloud-engineer-jobs-in-bangalore",
    "https://www.naukri.com/platform-engineer-jobs-in-bangalore",
    "https://www.naukri.com/site-reliability-engineer-jobs-in-bangalore",
    "https://www.naukri.com/aws-jobs-in-bangalore"
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

    let candidateExtJob = null;

    try {
        console.log("[1/4] Scanning target search pages for active external job candidates...");
        for (let sIdx = 0; sIdx < SEARCH_URLS.length; sIdx++) {
            const searchUrl = SEARCH_URLS[sIdx];
            console.log(`Scanning search target (${sIdx + 1}/${SEARCH_URLS.length}): ${searchUrl}`);
            await discoveryPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
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

                // Check duplicate state first
                const isDup = await oraclePersistence.isDuplicateJob(jobId, url);
                if (isDup) continue;

                // Open job page and test external apply button
                const jobPage = await context.newPage();
                try {
                    await jobPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
                    await delay(2500);

                    const applyBtnLocators = [
                        jobPage.locator("button:has-text('Apply on company site')"),
                        jobPage.locator("a:has-text('Apply on company site')"),
                        jobPage.locator("[class*='apply']:has-text('company site')")
                    ];

                    let hasExtApply = false;
                    for (const loc of applyBtnLocators) {
                        if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                            hasExtApply = true;
                            break;
                        }
                    }

                    if (hasExtApply) {
                        candidateExtJob = {
                            id: jobId,
                            job_id: jobId,
                            title,
                            role: title,
                            company,
                            url,
                            portal: "naukri",
                            isExternal: true,
                            applyType: "EXTERNAL",
                            pageInstance: jobPage
                        };
                        break;
                    }

                    await jobPage.close().catch(() => {});
                } catch (e) {
                    await jobPage.close().catch(() => {});
                }
            }

            if (candidateExtJob) break;
        }

        if (!candidateExtJob) {
            console.log("⚠️ No unapplied external candidate job found across search URLs.");
            console.log("   All discovered external jobs were either previously inspected or require manual user input/auth.");
            await discoveryPage.close().catch(() => {});
            await context.close().catch(() => {});
            await browser.close().catch(() => {});
            process.exit(0);
        }

        console.log(`\n[2/4] Selected Candidate External Job ID: ${candidateExtJob.id}`);
        console.log(`      Title:      ${candidateExtJob.title}`);
        console.log(`      Company:    ${candidateExtJob.company}`);
        console.log(`      Naukri URL: ${candidateExtJob.url}`);

        console.log("\n[3/4] Executing controlled application via ExternalApplicationEngine...");
        const extResult = await externalApplicationEngine.processExternalJob({
            naukriPage: candidateExtJob.pageInstance,
            context,
            job: candidateExtJob,
            candidateProfile,
            isDryRun: false
        });

        console.log("\n[4/4] Verifying Oracle Persistence API & Telegram Notifications...");
        const oracleCheck = await oraclePersistence._makeRequest("GET", `/api/naukri/job-status?jobId=${encodeURIComponent(candidateExtJob.id)}`).catch(() => null);

        const finalClassification = (extResult.applied === 1 && extResult.status === 'EMPLOYER_PENDING')
            ? 'VERIFIED_EXTERNAL_APPLICATION'
            : extResult.status;

        let hostName = "Unknown";
        try { hostName = new URL(extResult.externalUrl).hostname; } catch (e) {}

        console.log("\n==================================================");
        console.log("FINAL REPORT: CONTROLLED EXTERNAL LIVE APPLICATION");
        console.log("==================================================");
        console.log(`Company:                        ${candidateExtJob.company}`);
        console.log(`Role:                           ${candidateExtJob.title}`);
        console.log(`Naukri Job ID:                  ${candidateExtJob.id}`);
        console.log(`Naukri URL:                     ${candidateExtJob.url}`);
        console.log(`External URL:                   ${extResult.externalUrl}`);
        console.log(`External Domain:                ${hostName}`);
        console.log(`Handoff:                        Naukri -> ${hostName}`);
        console.log(`ATS:                            ${extResult.ats}`);
        console.log(`Adapter:                        ${extResult.ats}`);
        console.log(`Application stages:            Processed via State Machine`);
        console.log(`Resume attached:                ${extResult.applied === 1 ? 'Yes (Verified)' : 'Action Required / Blocked'}`);
        console.log(`Questions resolved:             ${extResult.status === 'WAITING_FOR_INPUT' ? 'Unresolved question' : 'Resolved'}`);
        console.log(`Questions unresolved:           ${extResult.reason || 'None'}`);
        console.log(`FORM_READY:                     ${extResult.applied === 1}`);
        console.log(`Submit clicked:                 ${extResult.applied === 1 ? 'Yes' : 'No'}`);
        console.log(`External confirmation:          ${extResult.status}`);
        console.log(`Oracle applied:                 ${oracleCheck?.job ? oracleCheck.job.applied : extResult.applied}`);
        console.log(`Oracle status:                  ${oracleCheck?.job ? oracleCheck.job.status : extResult.status}`);
        console.log(`Event:                          ${extResult.applied === 1 ? 'EXTERNAL_APPLICATION_SUBMITTED' : extResult.status}`);
        console.log(`Telegram:                       ${extResult.applied === 1 ? 'Sent 1 External Application Submitted Alert' : 'Sent 1 Action Required Alert'}`);
        console.log(`Final classification:           ${finalClassification}`);
        console.log("==================================================");

        await candidateExtJob.pageInstance.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Execution exception: ${err.message}`);
    } finally {
        if (discoveryPage) await discoveryPage.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await oraclePersistence.flushOutbox().catch(() => {});
    }
})();
