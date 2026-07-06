const browserPool = require("../packages/browser/BrowserPool");
const contextManager = require("../packages/browser/ContextManager");
const logger = require("../packages/logger");

(async () => {
    try {
        logger.automation.info("=== Starting BrowserPool & ContextManager verification check ===");
        
        const portal = "naukri";
        
        // 1. Check initial metadata mapping
        const meta = await contextManager.getMetadata(portal);
        logger.automation.info(`Initial metadata for ${portal}: ${JSON.stringify(meta)}`);
        
        // 2. Launch browser context through pool
        const instance = await browserPool.getInstance(portal);
        logger.automation.info(`Retrieved browser instance from pool for portal: ${portal}`);
        
        // 3. Tab validation & navigation
        const page = await instance.newPage();
        await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
        const title = await page.title();
        logger.automation.info(`Page title retrieved: "${title}"`);
        
        // 4. Test screenshot routine
        const screenshotPath = await instance.takeScreenshot(page, "pool_verification_run");
        logger.automation.info(`Verification screenshot saved at: ${screenshotPath}`);
        
        // 5. Check metadata update mapping
        const updatedMeta = await contextManager.getMetadata(portal);
        logger.automation.info(`Post-execution metadata for ${portal}: ${JSON.stringify(updatedMeta)}`);
        
        // 6. Inspect health maps
        const health = await browserPool.healthCheckAll();
        logger.automation.info(`Active pool browser health details: ${JSON.stringify(health)}`);
        
        // 7. Cleanup active pool instances
        await browserPool.closeAll();
        logger.automation.info("All browser context connections closed. Success.");
        process.exit(0);
    } catch (e) {
        console.error("BrowserPool verification failed:", e);
        process.exit(1);
    }
})();
