const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

process.env.DRY_RUN = "false";
process.env.ALLOW_LIVE_APPLICATIONS = "true";
process.env.ENABLE_CUTSHORT = "true";

const db = require("../packages/database");
const logger = require("../packages/logger");
const pluginManager = require("../packages/plugins/PluginManager");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT CONTROLLED LIVE TEST (PHASE 6)");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();
    pluginManager.loadPlugins();

    const plugin = pluginManager.getPlugin("cutshort");
    const browserInstance = new BrowserInstance("cutshort");

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();

        // Find candidate job matching all Phase 6 requirements:
        // 1. India eligible
        // 2. Not previously applied
        // 3. Title matches profile
        // 4. No unresolved candidate input needed
        const candidateJobs = await db.all("SELECT * FROM jobs WHERE portal = 'cutshort' AND (applied = 0 OR applied IS NULL) AND status != 'FAILED' AND status != 'WAITING_FOR_INPUT' ORDER BY id ASC");
        
        let targetJob = null;
        for (const j of candidateJobs) {
            const locCheck = checkLocationEligibility(j.location, j.title);
            if (locCheck.eligible) {
                targetJob = j;
                break;
            }
        }

        if (!targetJob) {
            console.log("No existing eligible job found in DB. Performing real-time discovery for 1 candidate job...");
            const discovered = await plugin.search(page, { keywordsList: ["DevOps Engineer"] });
            for (const d of discovered) {
                const locCheck = checkLocationEligibility(d.location, d.title);
                if (locCheck.eligible) {
                    await db.run(
                        "INSERT OR IGNORE INTO jobs (portal, job_id, company, title, location, experience, salary, url, status) VALUES ('cutshort', ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED')",
                        [d.job_id, d.company, d.title, d.location, d.experience, d.salary, d.url]
                    );
                    targetJob = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [d.job_id]);
                    break;
                }
            }
        }

        if (!targetJob) {
            console.error("❌ No suitable India-eligible target job found for Phase 6 controlled live test.");
            process.exit(1);
        }

        console.log(`🎯 Selected target job for CONTROLLED LIVE TEST:`);
        console.log(`   Job ID: ${targetJob.job_id}`);
        console.log(`   Title: ${targetJob.title}`);
        console.log(`   Company: ${targetJob.company}`);
        console.log(`   Location: ${targetJob.location}`);
        console.log(`   URL: ${targetJob.url}\n`);

        const result = await plugin.apply(page, targetJob);
        const finalRecord = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [targetJob.job_id]);

        console.log("\n==================================================");
        console.log("CUTSHORT CONTROLLED LIVE TEST RESULT");
        console.log("==================================================");
        console.log(`Execution Success: ${result}`);
        console.log(`Final DB Status: ${finalRecord ? finalRecord.status : "UNKNOWN"}`);
        console.log(`Applied Flag: ${finalRecord ? finalRecord.applied : 0}`);
        console.log(`Application Method: ${finalRecord ? finalRecord.application_method : "UNKNOWN"}`);
        console.log("==================================================\n");

    } catch (err) {
        console.error(`❌ Controlled Live Test failed: ${err.message}`);
    } finally {
        await browserInstance.close().catch(() => {});
    }
})();
