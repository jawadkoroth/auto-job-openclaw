const path = require("path");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const browserManager = require("../../packages/browser/BrowserManager");
const pluginManager = require("../../packages/plugins/PluginManager");
const telegramService = require("../telegram");

/**
 * Executes a specific plugin operation with full retries, error capturing, and Telegram notifications.
 * @param {string} pluginName 
 * @param {string} actionName 
 * @param {Object} args 
 * @returns {Promise<{success: boolean, result?: any, error?: string, duration: number}>}
 */
async function runJob(pluginName, actionName, args = {}) {
    const startTime = Date.now();
    const portal = pluginName.toLowerCase();
    
    logger.info(`Initializing worker job: ${portal}.${actionName}`, {
        plugin: portal,
        action: actionName
    });
    
    let attempt = 0;
    const maxRetries = config.retries;
    let lastError = null;
    let success = false;
    let result = null;

    // Notify Telegram platform started this job
    await telegramService.sendMessage(`🚀 *Job Started*: \`${portal}.${actionName}\``);

    while (attempt <= maxRetries && !success) {
        attempt++;
        if (attempt > 1) {
            logger.warn(`Retrying job execution (${attempt - 1}/${maxRetries}) for ${portal}.${actionName}`, {
                plugin: portal,
                action: actionName
            });
            await telegramService.sendMessage(`⚠️ *Retry Attempt* (${attempt - 1}/${maxRetries}) for \`${portal}.${actionName}\``);
        }

        try {
            // Initialize browser instance
            await browserManager.launch(portal);
            
            // Get plugin instance
            const plugin = pluginManager.getPlugin(portal);
            
            // Execute requested action
            switch (actionName) {
                case "login":
                    result = await plugin.login();
                    break;
                case "updateProfile":
                    result = await plugin.updateProfile();
                    break;
                case "apply":
                    const keywords = args.keywords || "Software Engineer";
                    const location = args.location || "";
                    
                    const jobs = await plugin.search({ keywords, location });
                    if (jobs && jobs.length > 0) {
                        result = await plugin.apply(jobs, args);
                    } else {
                        logger.info("Search returned zero jobs. Skipping application step.", { plugin: portal, action: actionName });
                        result = 0;
                    }
                    break;
                default:
                    // If a custom action exists on the plugin, run it
                    if (typeof plugin[actionName] === "function") {
                        result = await plugin[actionName](args);
                    } else {
                        throw new Error(`Action "${actionName}" does not exist in plugin: ${portal}`);
                    }
            }

            success = true;
        } catch (error) {
            lastError = error;
            logger.error(`Error in run attempt #${attempt}: ${error.message}`, {
                plugin: portal,
                action: actionName,
                success: false
            });

            // Auto-recovery screenshot and browser restart sequence
            try {
                const page = await browserManager.newPage().catch(() => null);
                if (page) {
                    const screenshotPath = await browserManager.takeScreenshot(page, `${portal}_${actionName}_fail_attempt_${attempt}`);
                    if (screenshotPath) {
                        await telegramService.sendPhoto(
                            screenshotPath, 
                            `❌ *Failure Alert* on \`${portal}.${actionName}\` (Attempt ${attempt}/${maxRetries + 1})\nError: \`${error.message}\``
                        );
                    }
                }
            } catch (screenshotErr) {
                logger.error(`Failed to capture failure state: ${screenshotErr.message}`);
            }

            // Force restart context for next loop
            try {
                await browserManager.restart();
            } catch (restartErr) {
                logger.error(`Browser recovery restart failed: ${restartErr.message}`);
            }
        }
    }

    const duration = Date.now() - startTime;
    
    // Close browser to release resources
    try {
        await browserManager.close();
    } catch (closeErr) {
        logger.error(`Error shutting down browser context: ${closeErr.message}`);
    }

    if (success) {
        logger.info(`Job completed successfully: ${portal}.${actionName}`, {
            plugin: portal,
            action: actionName,
            duration,
            success: true
        });
        
        let successMessage = `✅ *Job Success*: \`${portal}.${actionName}\` completed.`;
        if (actionName === "apply") {
            successMessage += `\nApplied to: *${result}* jobs.`;
        }
        await telegramService.sendMessage(successMessage);
        
        return { success: true, result, duration };
    } else {
        logger.error(`Job permanently failed: ${portal}.${actionName}`, {
            plugin: portal,
            action: actionName,
            duration,
            success: false,
            error: lastError.message
        });

        await telegramService.sendMessage(`🛑 *Job Failed*: \`${portal}.${actionName}\` failed all attempts.\nFinal Error: \`${lastError.message}\``);
        return { success: false, error: lastError.message, duration };
    }
}

module.exports = {
    runJob
};
