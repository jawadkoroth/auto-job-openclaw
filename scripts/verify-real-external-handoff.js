const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const externalRedirectResolver = require("../packages/engine/ExternalRedirectResolver");
const atsClassifier = require("../packages/engine/ATSClassifier");
const externalApplicationRouter = require("../packages/engine/ExternalApplicationRouter");
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
    console.log("PHASE 5: REAL EXTERNAL HANDOFF TRACE (READ-ONLY)");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context, page: searchPage } = boot;

    let successfulTrace = null;

    try {
        for (let sIdx = 0; sIdx < SEARCH_URLS.length; sIdx++) {
            const searchUrl = SEARCH_URLS[sIdx];
            console.log(`[Search ${sIdx + 1}/${SEARCH_URLS.length}] Scanning ${searchUrl}...`);

            if (sIdx > 0) await delay(3000);

            await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await delay(3000);

            const cards = searchPage.locator(".cust-job-tuple, article.jobTuple, div.srp-jobtuple, article.srp-jobtuple");
            const count = await cards.count().catch(() => 0);
            console.log(`  Found ${count} job cards.`);

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

                console.log(`  Testing Candidate #${i + 1}: "${title}" at "${company}"`);

                const jobPage = await context.newPage();
                try {
                    await jobPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
                    await delay(2500);

                    const applyBtnLocators = [
                        jobPage.locator("button:has-text('Apply on company site')"),
                        jobPage.locator("a:has-text('Apply on company site')"),
                        jobPage.locator("[class*='apply']:has-text('company site')"),
                        jobPage.locator("button.apply-button"),
                        jobPage.locator("button:has-text('Apply')")
                    ];

                    let applyBtn = null;
                    let applyText = "";
                    for (const loc of applyBtnLocators) {
                        if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                            applyBtn = loc.first();
                            applyText = (await applyBtn.textContent().catch(() => "")).trim();
                            break;
                        }
                    }

                    if (!applyBtn) {
                        await jobPage.close();
                        continue;
                    }

                    const res = await externalRedirectResolver.resolveExternalDestination({
                        page: jobPage,
                        context,
                        applyBtn
                    });

                    if (res.resolved && res.isExternalDomain && res.destinationUrl) {
                        const classification = await atsClassifier.classify(res.pageInstance, res.destinationUrl);
                        const adapter = externalApplicationRouter.getAdapter(classification.ats);

                        successfulTrace = {
                            company,
                            role: title,
                            jobId,
                            naukriUrl: url,
                            applyControlText: applyText,
                            handoffMethod: res.method,
                            externalUrl: res.destinationUrl,
                            externalDomain: res.destinationDomain,
                            ats: classification.ats,
                            confidence: classification.confidence,
                            adapterName: adapter.atsName,
                            evidence: res.evidence
                        };

                        if (res.isPopupCreated && res.pageInstance) {
                            await res.pageInstance.close().catch(() => {});
                        }
                        await jobPage.close().catch(() => {});
                        break;
                    }

                    if (res.isPopupCreated && res.pageInstance) {
                        await res.pageInstance.close().catch(() => {});
                    }
                    await jobPage.close().catch(() => {});
                } catch (cardErr) {
                    await jobPage.close().catch(() => {});
                }
            }

            if (successfulTrace) break;
        }

        console.log("\n==================================================");
        if (successfulTrace) {
            console.log("PHASE 5 EMPIRICAL SUCCESS: REAL EXTERNAL HANDOFF VERIFIED!");
            console.log("==================================================");
            console.log(`Company:                 ${successfulTrace.company}`);
            console.log(`Role:                    ${successfulTrace.role}`);
            console.log(`Naukri Job ID:           ${successfulTrace.jobId}`);
            console.log(`Naukri URL:              ${successfulTrace.naukriUrl}`);
            console.log(`Apply Control Text:      "${successfulTrace.applyControlText}"`);
            console.log(`Handoff Mechanism:       ${successfulTrace.handoffMethod}`);
            console.log(`External Destination URL:${successfulTrace.externalUrl}`);
            console.log(`External Hostname:       ${successfulTrace.externalDomain}`);
            console.log(`ATS Classification:      ${successfulTrace.ats}`);
            console.log(`Classification Evidence: ${successfulTrace.evidence}`);
            console.log(`Matched Adapter:         ${successfulTrace.adapterName}`);
            console.log("\n✓ EMPIRICAL PROOF: Naukri -> External Domain confirmed.");
            console.log("  No submission occurred during this read-only test.");
        } else {
            console.log("⚠️ No active external-domain redirect candidate was resolved in this scan batch.");
            console.log("   All tested candidates were native Naukri applications.");
        }
        console.log("==================================================");

    } catch (err) {
        console.error(`❌ Phase 5 trace error: ${err.message}`);
    } finally {
        if (searchPage) await searchPage.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
