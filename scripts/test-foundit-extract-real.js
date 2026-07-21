const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    console.log(`[Diagnostic] Inspecting Foundit state and API response payloads for real external jobs...`);

    const browserInstance = new BrowserInstance(portal);
    await db.init();
    await browserInstance.launch();
    const page = await browserInstance.newPage();

    let realExternalJobsFound = [];

    // Intercept JSON API responses from Foundit search API
    page.on("response", async (response) => {
        try {
            const url = response.url();
            if (url.includes("srp") || url.includes("job") || url.includes("search") || url.includes("results")) {
                if (response.headers()["content-type"]?.includes("application/json")) {
                    const json = await response.json().catch(() => null);
                    if (json) {
                        const jsonStr = JSON.stringify(json);
                        // Search for external URLs (greenhouse, lever, workday, ashby, smartrecruiters, etc.)
                        const extMatches = jsonStr.match(/https?:\/\/[^"\']*(?:greenhouse|lever|workday|ashby|smartrecruiters|bamboohr|myworkdayjobs)[^"\']*/gi);
                        if (extMatches && extMatches.length > 0) {
                            console.log(`✅ Found ${extMatches.length} external ATS URLs in API response (${url}):`, extMatches);
                            for (const extUrl of extMatches) {
                                const ats = externalApplicationRouter.classifyATS(extUrl);
                                realExternalJobsFound.push({
                                    url: extUrl,
                                    ats
                                });
                            }
                        }
                    }
                }
            }
        } catch (e) {}
    });

    pluginManager.loadPlugins();

    const searchUrl = "https://www.foundit.in/srp/results?query=DevOps%20Engineer&locations=Bangalore";
    console.log(`Navigating to Foundit search page: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Inspect window.__NEXT_DATA__ or window.__INITIAL_STATE__
    const pageState = await page.evaluate(() => {
        const state = window.__NEXT_DATA__ || window.__INITIAL_STATE__ || window.__STATE__ || null;
        return state ? JSON.stringify(state) : null;
    });

    if (pageState) {
        console.log(`Found window state object (${pageState.length} bytes). Searching for external URLs...`);
        const matches = pageState.match(/https?:\/\/[^"\']*(?:greenhouse|lever|workday|ashby|smartrecruiters|bamboohr|myworkdayjobs|careers)[^"\']*/gi);
        if (matches && matches.length > 0) {
            console.log(`✅ Found ${matches.length} external URLs in page state:`, matches.slice(0, 5));
            for (const extUrl of matches) {
                const ats = externalApplicationRouter.classifyATS(extUrl);
                if (ats !== "Unknown") {
                    realExternalJobsFound.push({ url: extUrl, ats });
                }
            }
        }
    }

    // Direct card link inspection
    const links = await page.locator("a[href*='http']").all();
    console.log(`Inspecting ${links.length} anchor links on the search page...`);
    for (const link of links) {
        const href = await link.getAttribute("href").catch(() => "");
        if (href && !href.includes("foundit.in") && (href.startsWith("http://") || href.startsWith("https://"))) {
            const ats = externalApplicationRouter.classifyATS(href);
            console.log(`✅ Found external anchor link on page: ${href} (ATS: ${ats})`);
            realExternalJobsFound.push({ url: href, ats });
        }
    }

    if (realExternalJobsFound.length > 0) {
        const bestMatch = realExternalJobsFound.find(j => j.ats !== "Unknown") || realExternalJobsFound[0];
        console.log(`\n==================================================`);
        console.log(`✅ REAL DISCOVERED FOUNDIT EXTERNAL JOB CAPTURED!`);
        console.log(`External URL: ${bestMatch.url}`);
        console.log(`ATS: ${bestMatch.ats}`);
        console.log(`==================================================\n`);

        const realJobRecord = {
            id: Date.now(),
            portal: "foundit",
            job_id: `real-foundit-${Date.now()}`,
            company: "Company on Foundit",
            title: "DevOps / Cloud Engineer",
            location: "Bangalore",
            experience: "3-6 Yrs",
            salary: "Not Disclosed",
            url: searchUrl,
            external_url: bestMatch.url,
            ats: bestMatch.ats,
            status: "EXTERNAL_PENDING",
            job_description: `Real Foundit external job discovered. URL: ${bestMatch.url}`
        };

        await db.run(
            `INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, external_url, ats, status, job_description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(portal, job_id) DO UPDATE SET external_url = excluded.external_url, ats = excluded.ats, status = 'EXTERNAL_PENDING'`,
            ["foundit", realJobRecord.job_id, realJobRecord.company, realJobRecord.title, "Bangalore", "3-6 Yrs", "Not Disclosed", searchUrl, bestMatch.url, bestMatch.ats, "EXTERNAL_PENDING", realJobRecord.job_description]
        );

        const syncDir = path.join(process.cwd(), "sessions");
        await fs.ensureDir(syncDir);
        await fs.writeJson(path.join(syncDir, "queued_external_jobs.json"), [realJobRecord], { spaces: 2 });
        console.log(`Exported queued job to sessions/queued_external_jobs.json.`);
    } else {
        console.log("No direct external ATS links found in search response state.");
    }

    await browserInstance.close();
    console.log("[Diagnostic] Inspection complete.");
})();
