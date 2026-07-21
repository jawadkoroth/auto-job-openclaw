const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    console.log(`[foundit:discover] Starting local Foundit discovery process...`);

    let networkAccess = "FAIL";
    let authStatus = "UNVERIFIED";
    let searchStatus = "NOT_TESTED";
    let jobsFoundCount = 0;
    let eligibleJobsCount = 0;
    let externalUrlsCapturedCount = 0;
    let queuedCount = 0;

    const browserInstance = new BrowserInstance(portal);
    let page;

    try {
        await db.init();
        await browserInstance.launch();
        page = await browserInstance.newPage();

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);

        // 1. Verify Network Access
        console.log("[foundit:discover] Checking network access to https://www.foundit.in/...");
        try {
            const resp = await page.goto("https://www.foundit.in/", { waitUntil: "domcontentloaded", timeout: 25000 });
            const status = resp ? resp.status() : 0;
            const pageTitle = await page.title().catch(() => "");
            
            if (status === 403 || pageTitle.includes("Access Denied")) {
                networkAccess = "BLOCKED_LOCAL_IP";
                console.error(`[foundit:discover] Network access blocked (HTTP ${status}, Title: "${pageTitle}").`);
            } else {
                networkAccess = "PASS";
                console.log(`[foundit:discover] Network access successful (HTTP ${status}).`);
            }
        } catch (netErr) {
            console.error(`[foundit:discover] Network connection error: ${netErr.message}`);
            networkAccess = "FAIL";
        }

        if (networkAccess === "PASS") {
            // 2. Verify Authentication State
            console.log("[foundit:discover] Verifying authentication state...");
            const isAuthed = await plugin.health(page).catch(() => false);
            if (isAuthed) {
                authStatus = "AUTHENTICATED";
                console.log("[foundit:discover] Active authenticated session confirmed.");
            } else {
                authStatus = "AUTH_REQUIRED";
                console.warn("[foundit:discover] Session unauthenticated. StorageState may require refresh.");
            }

            // 3. Perform Job Search
            console.log("[foundit:discover] Searching for DevOps/Cloud/Platform/SRE postings on Foundit...");
            const searchResults = await plugin.search(page, {
                keywordsList: ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "SRE"],
                locationsList: ["Bangalore"]
            }).catch(err => {
                console.error("[foundit:discover] Foundit search error:", err.message);
                return [];
            });

            if (searchResults && searchResults.length > 0) {
                searchStatus = "PASS";
                jobsFoundCount = searchResults.length;
                console.log(`[foundit:discover] Search completed. Found ${jobsFoundCount} postings.`);

                // 4. Inspect Jobs & Capture External Apply URLs
                for (const job of searchResults) {
                    try {
                        eligibleJobsCount++;
                        console.log(`[foundit:discover] Inspecting job: "${job.title}" at "${job.company}" (${job.url})`);
                        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
                        await page.waitForTimeout(1500);

                        const externalApplyBtn = page.locator("a:has-text('Apply on company website'), button:has-text('Apply on company website'), a:has-text('Apply on Company Site'), a.btn-apply-external").first();

                        if (await externalApplyBtn.count() > 0 && await externalApplyBtn.isVisible().catch(() => false)) {
                            console.log("[foundit:discover] External apply button detected. Capturing redirect URL...");
                            
                            const [popup] = await Promise.all([
                                page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
                                externalApplyBtn.click({ force: true }).catch(() => {})
                            ]);

                            const targetPage = popup || page;
                            await targetPage.waitForLoadState("domcontentloaded").catch(() => {});
                            await targetPage.waitForTimeout(3000);

                            const externalUrl = targetPage.url();
                            if (externalUrl && !externalUrl.includes("foundit.in")) {
                                externalUrlsCapturedCount++;
                                const classifiedAts = externalApplicationRouter.classifyATS(externalUrl);
                                console.log(`[foundit:discover] Captured External URL: ${externalUrl} (ATS: ${classifiedAts})`);

                                // Save to local SQLite database as EXTERNAL_PENDING
                                const existing = await db.get("SELECT id FROM jobs WHERE portal = ? AND job_id = ?", ["foundit", job.job_id]);
                                if (!existing) {
                                    await db.run(
                                        `INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, external_url, ats, status) 
                                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        ["foundit", job.job_id, job.company, job.title, job.location, job.experience || "", job.salary || "", job.url, externalUrl, classifiedAts, "EXTERNAL_PENDING"]
                                    );
                                } else {
                                    await db.run(
                                        `UPDATE jobs SET external_url = ?, ats = ?, status = 'EXTERNAL_PENDING' WHERE portal = ? AND job_id = ?`,
                                        [externalUrl, classifiedAts, "foundit", job.job_id]
                                    );
                                }
                            }

                            if (targetPage !== page) {
                                await targetPage.close().catch(() => {});
                            }
                        }
                    } catch (jobErr) {
                        console.warn(`[foundit:discover] Failed inspecting job ${job.url}: ${jobErr.message}`);
                    }
                }
            } else {
                searchStatus = "FAIL";
            }
        }

        // Export all local EXTERNAL_PENDING jobs for synchronization to Oracle VM
        const pendingJobs = await db.all("SELECT * FROM jobs WHERE status = 'EXTERNAL_PENDING'");
        queuedCount = pendingJobs.length;

        const syncDir = path.join(process.cwd(), "sessions");
        await fs.ensureDir(syncDir);
        const queuePayloadPath = path.join(syncDir, "queued_external_jobs.json");
        await fs.writeJson(queuePayloadPath, pendingJobs, { spaces: 2 });
        console.log(`[foundit:discover] Exported ${queuedCount} queued external jobs to ${queuePayloadPath}`);

    } catch (err) {
        console.error(`[foundit:discover] Execution error: ${err.message}`, err.stack);
    } finally {
        await browserInstance.close();
        console.log("[foundit:discover] Browser closed.");
    }

    console.log("\n==================================================");
    console.log("FOUNDIT LOCAL DISCOVERY");
    console.log("==================================================");
    console.log(`Network Access: ${networkAccess}`);
    console.log(`Authentication: ${authStatus}`);
    console.log(`Search: ${searchStatus}`);
    console.log(`Real Jobs Found: ${jobsFoundCount}`);
    console.log(`Eligible Jobs: ${eligibleJobsCount}`);
    console.log(`External Apply URLs Captured: ${externalUrlsCapturedCount}`);
    console.log(`Queued for External Processing: ${queuedCount}`);
    console.log("==================================================\n");
})();
