const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");

(async () => {
    const portal = "remoteok";
    console.log(`Starting ${portal} login test...`);
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        const success = await plugin.login(page);
        console.log(`Login result (Open Board): ${success ? "SUCCESS" : "FAILED"}`);
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
