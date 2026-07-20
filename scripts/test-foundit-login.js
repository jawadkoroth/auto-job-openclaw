const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    console.log(`Starting ${portal} login test...`);
    const browserInstance = new BrowserInstance(portal);
    
    let isAuthed = false;
    let isExported = "NO";
    let cookiesCount = 0;
    let originsCount = 0;
    let page;

    try {
        await browserInstance.launch();
        page = await browserInstance.newPage();

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);

        // Check if existing session is active
        console.log("[Diagnostic] Checking existing session health...");
        const initialHealth = await plugin.health(page);

        if (initialHealth) {
            console.log("[Diagnostic] Already authenticated via persistent context or storageState!");
            isAuthed = true;
        } else {
            console.log("[Diagnostic] Active session not detected. Initiating plugin login routine...");
            isAuthed = await plugin.login(page);
        }

        if (isAuthed) {
            console.log("[Diagnostic] Exporting portable storageState.json for Foundit...");
            const sessionDir = path.join(process.cwd(), "sessions", portal);
            await fs.ensureDir(sessionDir);
            const storageStatePath = path.join(sessionDir, "storageState.json");
            
            const state = await page.context().storageState();
            await fs.writeJson(storageStatePath, state, { spaces: 2 });

            if (await fs.pathExists(storageStatePath)) {
                isExported = "YES";
                cookiesCount = state.cookies ? state.cookies.length : 0;
                originsCount = state.origins ? state.origins.length : 0;
                console.log(`[Diagnostic] Successfully saved storageState.json: ${cookiesCount} cookies, ${originsCount} origins.`);
            }
        }
    } catch (err) {
        console.error(`[Diagnostic Error] ${portal} login failed: ${err.message}`, err.stack);
    } finally {
        await browserInstance.close();
        console.log("[Diagnostic] Browser closed.");
    }

    console.log("\n==================================================");
    console.log("FOUNDIT LOGIN DIAGNOSTIC RESULT");
    console.log("==================================================");
    console.log(`Portal: ${portal}`);
    console.log(`Authenticated: ${isAuthed ? "PASS" : "FAIL"}`);
    console.log(`StorageState Exported: ${isExported}`);
    console.log(`Cookies Transferred: ${cookiesCount}`);
    console.log(`Origins Transferred: ${originsCount}`);
    console.log("==================================================\n");
})();
