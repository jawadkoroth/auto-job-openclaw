const logger = require("../packages/logger");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    console.log("=== Testing new split logger ===");
    
    // Write log records across different categories
    logger.automation.info("Logging to automation log...");
    logger.browser.info("Logging to browser log...");
    logger.scheduler.info("Logging to scheduler log...");
    logger.telegram.info("Logging to telegram log...");
    logger.worker.info("Logging to worker log...");
    logger.plugin("naukri").info("Logging to naukri plugin log...");
    logger.plugin("linkedin").info("Logging to linkedin plugin log...");
    
    // Log metrics
    await logger.logMetric({ event: "test_run", status: "ok" });
    
    console.log("Waiting for files to settle on disk...");
    await new Promise(r => setTimeout(r, 1500));
    
    const logsDir = path.join(process.cwd(), "logs");
    const files = await fs.readdir(logsDir);
    console.log("Created logs directory files:", files);
    
    const pluginFiles = await fs.readdir(path.join(logsDir, "plugins"));
    console.log("Created plugin log files:", pluginFiles);
    
    process.exit(0);
})();
