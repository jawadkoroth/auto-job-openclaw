const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");

(async () => {
    pluginManager.loadPlugins();
    const plugin = pluginManager.getPlugin("cutshort");
    const browserInstance = new BrowserInstance("cutshort");

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        await page.goto("https://cutshort.io/jobs", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        const health = await plugin.health(page);
        const title = await page.title().catch(() => "");
        const url = page.url();

        const userAvatarCount = await page.locator("a[href*='/user/'], a[href*='/profile'], [class*='profile'], [class*='avatar'], [class*='user-name']").count().catch(() => 0);
        const loginBtnCount = await page.locator("a:has-text('Login'), button:has-text('Login'), a:has-text('Sign In')").count().catch(() => 0);

        console.log("==================================================");
        console.log("CUTSHORT AUTHENTICATION CHECK");
        console.log("==================================================");
        console.log(`Page URL:           ${url}`);
        console.log(`Page Title:         "${title}"`);
        console.log(`Plugin Health:      ${health}`);
        console.log(`User Avatar Count:  ${userAvatarCount}`);
        console.log(`Login Button Count: ${loginBtnCount}`);
        console.log("==================================================");

        if (health || (userAvatarCount > 0 && loginBtnCount === 0)) {
            console.log("AUTHENTICATED_SESSION_FOUND: YES");
        } else {
            console.log("AUTHENTICATED_SESSION_FOUND: NO");
        }

    } catch (e) {
        console.error("Auth check failed:", e.message);
    } finally {
        await browserInstance.close().catch(() => {});
    }
})();
