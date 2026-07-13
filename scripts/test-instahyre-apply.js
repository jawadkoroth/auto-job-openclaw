const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");

(async () => {
    const portal = "instahyre";
    console.log(`Starting ${portal} apply test...`);
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        await db.init();

        await plugin.login(page).catch(() => {});

        let job = await db.get("SELECT * FROM jobs WHERE portal = ? AND applied = 0 LIMIT 1", [portal]);
        if (!job) {
            job = {
                portal,
                job_id: "test-mock-id",
                title: "Mock DevOps Engineer",
                company: "Mock Company",
                url: "https://www.instahyre.com"
            };
        }
        
        console.log(`Applying to job: "${job.title}" at "${job.company}"`);
        const success = await plugin.apply(page, job);
        console.log(`Apply result: ${success ? "SUCCESS" : "SKIPPED/FAILED"}`);
        if (success) {
            console.log("SUCCESS");
        }
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
