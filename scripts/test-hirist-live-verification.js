const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

process.env.ENABLE_HIRIST = "true";
process.env.ENABLE_FOUNDIT = "false";
process.env.ENABLE_LINKEDIN = "false";
process.env.ENABLE_INSTAHYRE = "false";
process.env.ENABLE_WELLFOUND = "false";
process.env.ENABLE_REMOTEOK = "false";
process.env.ENABLE_WWR = "false";
process.env.ENABLE_NAUKRI = "false";
process.env.DRY_RUN = "false";
process.env.ALLOW_LIVE_APPLICATIONS = "true";

const db = require("../packages/database");
const pluginManager = require("../packages/plugins/PluginManager");
const browserPool = require("../packages/browser/BrowserPool");

(async () => {
    console.log("==================================================");
    console.log("HIRIST CONTROLLED LIVE APPLICATION TEST (1 LIVE)");
    console.log("==================================================\n");

    await db.init();
    pluginManager.loadPlugins();
    const plugin = pluginManager.getPlugin("hirist");
    if (!plugin) {
        console.error("❌ Hirist plugin not found!");
        process.exit(1);
    }

    let browserInstance = null;
    let page = null;

    try {
        browserInstance = await browserPool.getInstance("hirist");
        page = await browserInstance.newPage();

        const loginOk = await plugin.login(page);
        if (!loginOk) {
            console.error("❌ Hirist authentication failed!");
            process.exit(1);
        }

        console.log("Searching for live Hirist job candidates...");
        const rawJobs = await plugin.search(page, { keywordsList: ["DevOps Engineer"], locationsList: ["Bangalore"] });
        console.log(`Discovered ${rawJobs.length} potential jobs on Hirist.`);

        let targetJob = null;
        for (const job of rawJobs) {
            const isDup = await db.isDuplicateJob("hirist", job.job_id);
            if (!isDup) {
                targetJob = job;
                break;
            }
        }

        if (!targetJob) {
            console.log("No unapplied job candidates available for live test.");
            process.exit(0);
        }

        console.log(`\nSelected Target Job for Live Application Test:`);
        console.log(`Job ID: ${targetJob.job_id}`);
        console.log(`Title: ${targetJob.title}`);
        console.log(`Company: ${targetJob.company}`);
        console.log(`URL: ${targetJob.url}\n`);

        const result = await plugin.apply(page, targetJob);
        console.log(`Apply engine result:`, result);
        console.log(`Target job status:`, targetJob.status);
        console.log(`Target job statusReason:`, targetJob.statusReason);

        // Verification checks across Oracle DB and application_events
        console.log("\n--- VERIFYING ORACLE DATABASE & EVENT LOGS ---");
        const dbJob = await db.get("SELECT * FROM jobs WHERE portal = 'hirist' AND (job_id = ? OR id = ?)", [targetJob.job_id, targetJob.job_id]);
        console.log("Database Job Record:", JSON.stringify(dbJob, null, 2));

        const events = await db.all("SELECT * FROM application_events WHERE portal = 'hirist' AND job_id = ? ORDER BY id DESC LIMIT 5", [String(targetJob.job_id)]);
        console.log("Application Events Count:", events.length);
        if (events.length > 0) {
            console.log("Latest Application Event:", JSON.stringify(events[0], null, 2));
        }

        const artifactDir = path.join(process.cwd(), "sessions", "hirist", "verification", String(targetJob.job_id));
        const verificationJsonPath = path.join(artifactDir, "verification.json");
        const artifactExists = require("fs").existsSync(verificationJsonPath);
        console.log(`Verification Evidence Artifact Exists: ${artifactExists ? "YES (" + verificationJsonPath + ")" : "NO"}`);
        if (artifactExists) {
            console.log("Artifact Payload:", JSON.stringify(require("fs-extra").readJsonSync(verificationJsonPath), null, 2));
        }

        console.log("\n==================================================");
        console.log("LIVE TEST COMPLETED SUCCESSFULLY");
        console.log("==================================================");

    } catch (err) {
        console.error("Live test failed with error:", err);
    } finally {
        if (browserInstance) {
            await browserInstance.close().catch(() => {});
        }
        process.exit(0);
    }
})();
