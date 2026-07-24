const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger");
const pluginManager = require("../packages/plugins/PluginManager");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const conversationMonitor = require("../packages/plugins/cutshort/ConversationMonitor");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT CONVERSATION MONITOR RUNNER (PHASE 6)");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();
    pluginManager.loadPlugins();

    const plugin = pluginManager.getPlugin("cutshort");
    const browserInstance = new BrowserInstance("cutshort");

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();

        // Perform health check / login
        const loggedIn = await plugin.health(page);
        if (!loggedIn) {
            console.log("[Conversation Monitor] Session check failed. Attempting login...");
            const loginSuccess = await plugin.login(page);
            if (!loginSuccess) {
                console.error("❌ Cutshort authentication required for Conversation Monitor but login failed.");
                await browserInstance.close();
                process.exit(1);
            }
        }

        console.log("[Conversation Monitor] Running Cutshort conversation scan...");
        const metrics = await conversationMonitor.scanConversations(page);

        console.log("\n==================================================");
        console.log("CUTSHORT CONVERSATION MONITOR REPORT");
        console.log("==================================================");
        console.log(`Conversations Scanned: ${metrics.scanned}`);
        console.log(`Conversations Updated: ${metrics.updated}`);
        console.log(`Pending Input Prompted: ${metrics.pendingInput}`);
        console.log("--------------------------------------------------");

        await browserInstance.close();
        process.exit(0);

    } catch (err) {
        console.error(`❌ Conversation Monitor Error: ${err.message}`);
        await browserInstance.close().catch(() => {});
        process.exit(1);
    }
})();
