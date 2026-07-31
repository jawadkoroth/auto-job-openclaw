const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SEARCH_URLS = [
    "https://www.naukri.com/devops-jobs-in-bangalore",
    "https://www.naukri.com/cloud-engineer-jobs-in-bangalore",
    "https://www.naukri.com/site-reliability-engineer-jobs-in-bangalore",
    "https://www.naukri.com/platform-engineer-jobs-in-bangalore",
    "https://www.naukri.com/aws-jobs-in-bangalore"
];

(async () => {
    console.log("==================================================");
    console.log("PHASE 25: NAUKRI EXPERIENCE RANGE OVERLAP STATISTICAL ANALYSIS");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context, page } = boot;

    const yoeDistribution = {};
    let totalCardsScanned = 0;
    let totalOverlapEligible = 0;
    let strictPolicyEligible = 0; // jobMin >= 1 && jobMax <= 6

    try {
        for (let sIdx = 0; sIdx < SEARCH_URLS.length; sIdx++) {
            const url = SEARCH_URLS[sIdx];
            console.log(`[${sIdx + 1}/${SEARCH_URLS.length}] Scanning ${url}...`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await delay(3000);

            const expElements = page.locator(".exp, .experience, [class*='exp']");
            const count = await expElements.count().catch(() => 0);

            for (let i = 0; i < count; i++) {
                const txt = (await expElements.nth(i).textContent().catch(() => "")).trim();
                const match = txt.match(/([0-9]+)\s*-\s*([0-9]+)\s*Yrs/i);
                if (match) {
                    totalCardsScanned++;
                    const min = parseInt(match[1], 10);
                    const max = parseInt(match[2], 10);
                    const rangeKey = `${min}-${max}`;

                    yoeDistribution[rangeKey] = (yoeDistribution[rangeKey] || 0) + 1;

                    // Current policy: jobMin <= 6 && jobMax >= 1
                    if (min <= 6 && max >= 1) {
                        totalOverlapEligible++;
                    }

                    // Strict policy: jobMin >= 1 && jobMax <= 6
                    if (min >= 1 && max <= 6) {
                        strictPolicyEligible++;
                    }
                }
            }
        }

        console.log("\n==================================================");
        console.log("NAUKRI YOE DISTRIBUTION STATISTICS REPORT:");
        console.log("==================================================");
        console.log(`Total Job Cards Scanned:      ${totalCardsScanned}`);
        console.log(`Current Policy Eligible:     ${totalOverlapEligible} (${((totalOverlapEligible / Math.max(1, totalCardsScanned)) * 100).toFixed(1)}%) [jobMin <= 6 && jobMax >= 1]`);
        console.log(`Strict Policy Eligible:      ${strictPolicyEligible} (${((strictPolicyEligible / Math.max(1, totalCardsScanned)) * 100).toFixed(1)}%) [jobMin >= 1 && jobMax <= 6]`);
        console.log(`Overlap-Only Candidates:     ${totalOverlapEligible - strictPolicyEligible} (${(((totalOverlapEligible - strictPolicyEligible) / Math.max(1, totalCardsScanned)) * 100).toFixed(1)}%)`);

        console.log("\nDetailed Experience Range Breakdown:");
        const sortedKeys = Object.keys(yoeDistribution).sort((a, b) => {
            const [aMin] = a.split('-').map(Number);
            const [bMin] = b.split('-').map(Number);
            return aMin - bMin;
        });

        sortedKeys.forEach(key => {
            const [min, max] = key.split('-').map(Number);
            const isOverlap = min <= 6 && max >= 1;
            const isStrict = min >= 1 && max <= 6;
            const flag = isStrict ? 'STRICT_ELIGIBLE' : (isOverlap ? 'OVERLAP_ONLY_ELIGIBLE' : 'INELIGIBLE');
            console.log(`  • ${key.padEnd(8)} Yrs : ${String(yoeDistribution[key]).padStart(3)} jobs  [${flag}]`);
        });

        console.log("\nPolicy Recommendation:");
        console.log("Keep current policy: (jobMin <= 6 && jobMax >= 1) because upper-bound ranges");
        console.log("(e.g., 4-8 YOE, 4-9 YOE, 3-8 YOE) represent mid-level DevOps roles for 3-5 YOE candidate profile.");
        console.log("==================================================");

        await page.close().catch(() => {});
    } catch (err) {
        console.error(`❌ YOE analysis exception: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
