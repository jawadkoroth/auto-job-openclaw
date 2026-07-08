const browserManager = require("../packages/browser/BrowserManager");
const { automation: logger } = require("../packages/logger");

(async () => {
    try {
        logger.info("Starting BrowserManager verification check...");
        
        // 1. Launch a portal context
        const context = await browserManager.launch("naukri");
        logger.info("Browser persistent context launched.");

        // 2. Open active page
        const page = await browserManager.newPage();
        logger.info("Active tab established.");

        // 3. Navigate & test page controls
        await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
        const title = await page.title();
        logger.info(`Page title retrieved: "${title}"`);

        // 4. Capture screenshot
        const screenshotPath = await browserManager.takeScreenshot(page, "browser_manager_test");
        logger.info(`Screenshot verification saved at: ${screenshotPath}`);

        // 5. Test health status checks
        const isHealthy = await browserManager.healthCheck();
        logger.info(`Browser health status: ${isHealthy ? "ONLINE" : "UNHEALTHY"}`);

        // 6. Terminate context
        await browserManager.close();
        logger.info("Browser context terminated gracefully. Verification SUCCESS.");
        process.exit(0);
    } catch (error) {
        logger.error(`BrowserManager verification failed: ${error.stack}`);
        process.exit(1);
    }
})();
