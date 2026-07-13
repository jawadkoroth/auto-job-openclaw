const BrowserInstance = require("../packages/browser/BrowserInstance");
const config = require("../packages/config");

(async () => {
    const portal = "foundit";
    console.log(`Starting ${portal} home page test...`);
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        const url = config.portals[portal].url;
        console.log(`Navigating to ${url}...`);
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        console.log(`HTTP Status: ${response.status()}`);
        console.log(`Page Title:  ${await page.title()}`);
        console.log("SUCCESS");
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
