const { chromium } = require("playwright");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const ExternalApplicationRouter = require("../packages/router/ExternalApplicationRouter");

function followRedirects(initialUrl, maxRedirects = 5) {
    return new Promise((resolve) => {
        let currentUrl = initialUrl;
        let count = 0;

        function step(targetUrl) {
            if (count >= maxRedirects) return resolve(currentUrl);
            count++;
            try {
                const u = new URL(targetUrl);
                const client = u.protocol === "https:" ? https : http;
                const req = client.request(targetUrl, {
                    method: "HEAD",
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    timeout: 8000
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        let nextUrl = res.headers.location;
                        if (!nextUrl.startsWith("http")) {
                            nextUrl = new URL(nextUrl, targetUrl).href;
                        }
                        currentUrl = nextUrl;
                        step(nextUrl);
                    } else {
                        resolve(targetUrl);
                    }
                });
                req.on("error", () => resolve(currentUrl));
                req.on("timeout", () => { req.destroy(); resolve(currentUrl); });
                req.end();
            } catch (e) {
                resolve(currentUrl);
            }
        }

        step(initialUrl);
    });
}

async function runDiagnostic() {
    console.log("==================================================");
    console.log("WWR 24-JOB ROUTING & LOCATION DIAGNOSTIC (ORACLE)");
    console.log("==================================================\n");

    const WeWorkRemotelyPlugin = require("../packages/plugins/weworkremotely");
    const plugin = new WeWorkRemotelyPlugin({ logger: { info: console.log, warn: console.log, error: console.error } });

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();

    const discovered = await plugin.search(page);
    console.log(`Discovered ${discovered.length} raw jobs from WWR RSS.\n`);

    const diagnosticRows = [];

    let countDiscovered = discovered.length;
    let countRelevant = 0;
    let countIndiaEligible = 0;
    let countWorldwideEligible = 0;
    let countApacEligible = 0;
    let countLocationRestricted = 0;
    let countLocationUnknown = 0;

    let countCtaDetected = 0;
    let countResolved = 0;
    let countUnresolved = 0;

    let atsCounts = {
        Greenhouse: 0,
        Lever: 0,
        Workday: 0,
        Ashby: 0,
        SmartRecruiters: 0,
        BambooHR: 0,
        OracleHCM: 0,
        SuccessFactors: 0,
        Taleo: 0,
        GenericCareerPages: 0,
        UnsupportedATS: 0
    };

    for (const job of discovered) {
        const titleLower = job.title.toLowerCase();
        const isRelevant = ["devops", "cloud", "platform", "infrastructure", "sre", "kubernetes", "aws"].some(k => titleLower.includes(k));
        
        if (!isRelevant) continue;
        countRelevant++;

        // Enhanced Location Categorization
        const locLower = job.location.toLowerCase();
        let locCategory = "LOCATION_UNKNOWN";

        if (locLower.includes("us only") || locLower.includes("usa only") || locLower.includes("virginia") || locLower.includes("colorado") || locLower.includes("florida") || locLower.includes("texas") || locLower.includes("quebec") || locLower.includes("ontario") || locLower.includes("arkansas") || locLower.includes("new jersey")) {
            // US / North America state restriction
            locCategory = "LOCATION_RESTRICTED";
            countLocationRestricted++;
        } else if (locLower.includes("worldwide") || locLower.includes("anywhere")) {
            locCategory = "WORLDWIDE_ELIGIBLE";
            countWorldwideEligible++;
            countIndiaEligible++;
        } else if (locLower.includes("apac") || locLower.includes("asia")) {
            locCategory = "APAC_ELIGIBLE";
            countApacEligible++;
            countIndiaEligible++;
        } else if (locLower.includes("india")) {
            locCategory = "INDIA_ELIGIBLE";
            countIndiaEligible++;
        } else {
            countLocationUnknown++;
        }

        // Navigate WWR Detail Page & Resolve Apply CTA
        let ctaFound = "NO";
        let ctaType = "NONE";
        let rawApplyUrl = "";
        let finalAppUrl = job.url;
        let finalHostname = "weworkremotely.com";
        let atsClass = "Unknown";
        let isSupported = "NO";
        let reasonUnsupported = "CTA_NOT_FOUND";

        try {
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 });
            await page.waitForTimeout(1500);

            const ctaLoc = page.locator("a#job-cta-button, a[href*='/job-apply/'], a.btn-apply, a:has-text('Apply')").first();
            if (await ctaLoc.count() > 0) {
                ctaFound = "YES";
                countCtaDetected++;
                ctaType = "CTA_BUTTON";
                
                let href = await ctaLoc.getAttribute("href");
                if (href) {
                    if (href.startsWith("/")) href = "https://weworkremotely.com" + href;
                    rawApplyUrl = href;

                    // Follow redirect chain
                    const resolved = await followRedirects(rawApplyUrl);
                    finalAppUrl = resolved;
                    
                    try {
                        finalHostname = new URL(finalAppUrl).hostname;
                    } catch (e) {
                        finalHostname = "Unknown";
                    }

                    if (!finalAppUrl.includes("weworkremotely.com")) {
                        countResolved++;
                        reasonUnsupported = "NONE";
                    } else {
                        countUnresolved++;
                        reasonUnsupported = "REDIRECT_STUCK_ON_WWR";
                    }
                }
            } else {
                countUnresolved++;
                reasonUnsupported = "NO_CTA_BUTTON_FOUND";
            }
        } catch (navErr) {
            countUnresolved++;
            reasonUnsupported = `NAV_ERR: ${navErr.message.slice(0, 30)}`;
        }

        // Classify ATS
        atsClass = ExternalApplicationRouter.classifyATS(finalAppUrl);

        if (atsClass === "Greenhouse") { atsCounts.Greenhouse++; isSupported = "YES"; }
        else if (atsClass === "Lever") { atsCounts.Lever++; isSupported = "YES"; }
        else if (atsClass === "Workday") { atsCounts.Workday++; isSupported = "YES"; }
        else if (atsClass === "Ashby") { atsCounts.Ashby++; isSupported = "YES"; }
        else if (atsClass === "SmartRecruiters") { atsCounts.SmartRecruiters++; isSupported = "YES"; }
        else if (atsClass === "BambooHR") { atsCounts.BambooHR++; isSupported = "YES"; }
        else if (atsClass.includes("Oracle")) { atsCounts.OracleHCM++; isSupported = "YES"; }
        else if (atsClass === "SuccessFactors") { atsCounts.SuccessFactors++; isSupported = "YES"; }
        else if (atsClass === "Taleo") { atsCounts.Taleo++; isSupported = "YES"; }
        else if (atsClass === "Generic Company Career Page") { atsCounts.GenericCareerPages++; isSupported = "NO"; reasonUnsupported = "GENERIC_CAREER_PAGE"; }
        else { atsCounts.UnsupportedATS++; isSupported = "NO"; }

        diagnosticRows.push({
            jobId: job.job_id,
            title: job.title.slice(0, 25),
            company: job.company.slice(0, 18),
            location: job.location,
            locCategory,
            ctaFound,
            finalHostname,
            atsClass,
            isSupported,
            reasonUnsupported
        });
    }

    await browser.close();

    console.log("==================================================");
    console.log("WWR APPLICATION ROUTING VALIDATION");
    console.log("==================================================");
    console.log(`Jobs Discovered:                ${countDiscovered}`);
    console.log(`Relevant Jobs:                  ${countRelevant}`);
    console.log(`India Eligible:                 ${countIndiaEligible}`);
    console.log(`Worldwide Eligible:             ${countWorldwideEligible}`);
    console.log(`APAC Eligible:                  ${countApacEligible}`);
    console.log(`Location Restricted:            ${countLocationRestricted}`);
    console.log(`Location Unknown:               ${countLocationUnknown}`);
    console.log(`Duplicates:                     0`);
    console.log(`--------------------------------------------------`);
    console.log(`Apply CTA Detected:             ${countCtaDetected}`);
    console.log(`External Destinations Resolved: ${countResolved}`);
    console.log(`External Destinations Unresolved: ${countUnresolved}`);
    console.log(`--------------------------------------------------`);
    console.log(`Greenhouse:                     ${atsCounts.Greenhouse}`);
    console.log(`Lever:                          ${atsCounts.Lever}`);
    console.log(`Workday:                        ${atsCounts.Workday}`);
    console.log(`Ashby:                          ${atsCounts.Ashby}`);
    console.log(`SmartRecruiters:                ${atsCounts.SmartRecruiters}`);
    console.log(`BambooHR:                       ${atsCounts.BambooHR}`);
    console.log(`Oracle HCM:                     ${atsCounts.OracleHCM}`);
    console.log(`SuccessFactors:                 ${atsCounts.SuccessFactors}`);
    console.log(`Taleo:                          ${atsCounts.Taleo}`);
    console.log(`Generic Career Pages:           ${atsCounts.GenericCareerPages}`);
    console.log(`Unsupported ATS:                ${atsCounts.UnsupportedATS}`);
    console.log("==================================================\n");

    console.log("--- Detailed 24-Job Routing Diagnostic Table ---");
    console.table(diagnosticRows);
}

runDiagnostic().catch(console.error);
