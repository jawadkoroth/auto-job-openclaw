const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "hirist";
    console.log(`Starting ${portal} login test...`);
    const browserInstance = new BrowserInstance(portal);
    
    let isAuthed = false;
    let isExported = "NO";
    let cookiesCount = 0;
    let originsCount = 0;

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        const success = await plugin.login(page);
        
        if (success) {
            isAuthed = true;
            
            // Explicitly export storageState.json
            const storageStatePath = path.join(process.cwd(), "sessions", portal, "storageState.json");
            await page.context().storageState({ path: storageStatePath });
            
            if (fs.existsSync(storageStatePath)) {
                isExported = "YES";
                const state = fs.readJsonSync(storageStatePath);
                cookiesCount = state.cookies ? state.cookies.length : 0;
                originsCount = state.origins ? state.origins.length : 0;
            }
        }
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }

    console.log("\n==================================================");
    console.log("HIRIST LOCAL AUTH BOOTSTRAP");
    console.log("==================================================");
    console.log(`Authentication: ${isAuthed ? "AUTHENTICATED" : "FAILED"}`);
    console.log(`StorageState Exported: ${isExported}`);
    console.log(`Cookies Exported: ${cookiesCount}`);
    console.log(`Origins Exported: ${originsCount}`);
    console.log("==================================================\n");
})();
