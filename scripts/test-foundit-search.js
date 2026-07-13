const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");

(async () => {
    const portal = "foundit";
    console.log(`Starting ${portal} search test...`);
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        
        await plugin.login(page).catch(() => {});

        const jobs = await plugin.search(page, { keywords: "DevOps", location: "Bangalore" });
        console.log(`Search returned ${jobs.length} jobs.`);
        if (jobs.length > 0) {
            console.log("Sample Job:", JSON.stringify(jobs[0], null, 2));
            console.log("SUCCESS");
        } else {
            console.log("No jobs returned. FAILED");
        }
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
