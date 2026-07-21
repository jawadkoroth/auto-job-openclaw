const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    console.log(`[Diagnostic] Discovering multiple real Foundit external ATS jobs...`);

    const browserInstance = new BrowserInstance(portal);
    await db.init();
    await browserInstance.launch();
    const page = await browserInstance.newPage();

    let discoveredExternalJobs = [];

    // Intercept JSON API responses from Foundit search API
    page.on("response", async (response) => {
        try {
            const url = response.url();
            if (url.includes("srp") || url.includes("job") || url.includes("search") || url.includes("results") || url.includes("middleware")) {
                if (response.headers()["content-type"]?.includes("application/json")) {
                    const json = await response.json().catch(() => null);
                    if (json) {
                        const jsonStr = JSON.stringify(json);
                        const extMatches = jsonStr.match(/https?:\/\/[^"\']*(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com)[^"\']*/gi);
                        if (extMatches && extMatches.length > 0) {
                            for (const extUrl of extMatches) {
                                const ats = externalApplicationRouter.classifyATS(extUrl);
                                if (!discoveredExternalJobs.some(j => j.external_url === extUrl)) {
                                    discoveredExternalJobs.push({
                                        id: Date.now() + discoveredExternalJobs.length,
                                        portal: "foundit",
                                        job_id: `real-foundit-${Date.now()}-${discoveredExternalJobs.length}`,
                                        company: "Discovered Employer",
                                        title: "DevOps / Software Engineer",
                                        location: "Bangalore",
                                        experience: "3-6 Yrs",
                                        salary: "Not Disclosed",
                                        url: extUrl,
                                        external_url: extUrl,
                                        ats: ats,
                                        status: "EXTERNAL_PENDING",
                                        job_description: `Real Foundit external job discovered. URL: ${extUrl}`
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {}
    });

    pluginManager.loadPlugins();

    const searchKeywords = ["DevOps", "Greenhouse", "Lever", "Cloud Engineer"];

    for (const kw of searchKeywords) {
        const searchUrl = `https://www.foundit.in/srp/results?query=${encodeURIComponent(kw)}&locations=Bangalore`;
        console.log(`\nNavigating to search URL: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 35000 }).catch(() => {});
        await page.waitForTimeout(3000);

        if (discoveredExternalJobs.length >= 3) break;
    }

    if (discoveredExternalJobs.length > 0) {
        console.log(`\n==================================================`);
        console.log(`✅ DISCOVERED ${discoveredExternalJobs.length} REAL FOUNDIT EXTERNAL JOBS:`);
        for (const j of discoveredExternalJobs) {
            console.log(`- ATS: ${j.ats} | URL: ${j.external_url}`);
        }
        console.log(`==================================================\n`);

        for (const j of discoveredExternalJobs) {
            await db.run(
                `INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, external_url, ats, status, job_description)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(portal, job_id) DO UPDATE SET external_url = excluded.external_url, ats = excluded.ats, status = 'EXTERNAL_PENDING'`,
                ["foundit", j.job_id, j.company, j.title, j.location, j.experience, j.salary, j.url, j.external_url, j.ats, "EXTERNAL_PENDING", j.job_description]
            );
        }

        const syncDir = path.join(process.cwd(), "sessions");
        await fs.ensureDir(syncDir);
        await fs.writeJson(path.join(syncDir, "queued_external_jobs.json"), discoveredExternalJobs, { spaces: 2 });
        console.log(`Saved ${discoveredExternalJobs.length} queued jobs to sessions/queued_external_jobs.json.`);
    } else {
        console.log("No external ATS URLs captured during discovery.");
    }

    await browserInstance.close();
    console.log("[Diagnostic] Done.");
})();
