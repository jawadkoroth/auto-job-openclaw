const browserManager = require("../packages/browser/BrowserManager");
const logger = require("../packages/logger");

(async () => {
    try {
        await browserManager.launch("naukri");

        const page = await browserManager.newPage();

        logger.info("Opening Naukri...");

        await page.goto("https://www.naukri.com", {
            waitUntil: "networkidle",
            timeout: 60000
        });

        console.log("Current Title:", await page.title());

        await browserManager.takeScreenshot(page, "naukri-home");

        console.log("✅ Screenshot saved.");

    } catch (err) {
        console.error(err);
    } finally {
        await browserManager.close();
    }
})();
