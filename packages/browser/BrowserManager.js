const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");
const config = require("../config");
const logger = require("../logger");
const sessionManager = require("../session/SessionManager");

class BrowserManager {
    constructor() {
        this.context = null;
        this.currentPortal = null;
        this.screenshotDir = path.join(process.cwd(), "screenshots");
        fs.ensureDirSync(this.screenshotDir);
    }

    /**
     * Launch persistent context for the specified job portal
     * @param {string} portalName 
     * @returns {Promise<import("playwright").BrowserContext>}
     */
    async launch(portalName) {
        if (!portalName) {
            throw new Error("Portal name must be provided to launch browser.");
        }

        const normPortal = portalName.toLowerCase();

        // If context already exists and is for the same portal, return it if healthy
        if (this.context && this.currentPortal === normPortal) {
            if (await this.healthCheck()) {
                return this.context;
            }
            logger.warn(`Existing browser context for ${portalName} is unhealthy. Recreating...`, {
                plugin: normPortal,
                action: "browser_launch"
            });
            await this.close();
        } else if (this.context) {
            // Context is for a different portal, close it to switch
            logger.info(`Switching portal context from ${this.currentPortal} to ${normPortal}. Closing current...`, {
                plugin: normPortal,
                action: "browser_switch"
            });
            await this.close();
        }

        this.currentPortal = normPortal;
        const sessionPath = sessionManager.getSessionPath(this.currentPortal);

        logger.info(`Launching persistent browser context for ${portalName}`, {
            plugin: portalName,
            action: "browser_launch"
        });

        try {
            this.context = await chromium.launchPersistentContext(sessionPath, {
                headless: config.browser.headless,
                viewport: config.browser.viewport,
                args: config.browser.args,
                timeout: config.browser.timeout
            });

            // Set default timeout on the context if applicable
            this.context.setDefaultTimeout(config.browser.timeout);

            // Handle unexpected closure
            this.context.on("close", () => {
                if (this.intentionalClose) return;
                logger.warn("Browser context closed unexpectedly.", {
                    plugin: this.currentPortal,
                    action: "browser_close_event"
                });
                this.context = null;
            });

            return this.context;
        } catch (error) {
            logger.error(`Failed to launch browser context: ${error.message}`, {
                plugin: portalName,
                action: "browser_launch",
                success: false
            });
            throw error;
        }
    }

    /**
     * Get or create a page
     * @returns {Promise<import("playwright").Page>}
     */
    async newPage() {
        if (!this.context) {
            throw new Error("Browser has not been launched. Call launch() first.");
        }

        try {
            const pages = this.context.pages();
            if (pages.length > 0) {
                return pages[0];
            }
            return await this.context.newPage();
        } catch (error) {
            logger.error(`Failed to retrieve/create page: ${error.message}. Triggering recovery...`, {
                plugin: this.currentPortal,
                action: "new_page",
                success: false
            });
            await this.restart();
            return await this.context.newPage();
        }
    }

    /**
     * Gracefully close the active context
     */
    async close() {
        if (this.context) {
            logger.info(`Closing browser context for ${this.currentPortal}`, {
                plugin: this.currentPortal,
                action: "browser_close"
            });
            try {
                this.intentionalClose = true;
                await this.context.close();
            } catch (error) {
                logger.error(`Error closing browser context: ${error.message}`, {
                    plugin: this.currentPortal,
                    action: "browser_close",
                    success: false
                });
            } finally {
                this.context = null;
                this.currentPortal = null;
                this.intentionalClose = false;
            }
        }
    }

    /**
     * Evaluate context healthiness
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        if (!this.context) return false;
        try {
            const pages = this.context.pages();
            if (pages.length === 0) {
                const tempPage = await this.context.newPage();
                await tempPage.close();
            } else {
                await pages[0].evaluate(() => 1 + 1);
            }
            return true;
        } catch (error) {
            logger.warn(`Browser health check failed: ${error.message}`, {
                plugin: this.currentPortal,
                action: "health_check"
            });
            return false;
        }
    }

    /**
     * Restart current browser context
     * @returns {Promise<import("playwright").BrowserContext>}
     */
    async restart() {
        if (!this.currentPortal) {
            throw new Error("No active portal context to restart.");
        }
        const portal = this.currentPortal;
        logger.info(`Restarting browser context for portal: ${portal}`, {
            plugin: portal,
            action: "browser_restart"
        });
        await this.close();
        return await this.launch(portal);
    }

    /**
     * Capture page screenshot
     * @param {import("playwright").Page} page 
     * @param {string} name 
     * @returns {Promise<string|null>} Filepath of saved screenshot
     */
    async takeScreenshot(page, name) {
        if (!page) {
            logger.warn("No active page provided to take screenshot.");
            return null;
        }
        const filename = `${Date.now()}-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
        const fullPath = path.join(this.screenshotDir, filename);

        try {
            await page.screenshot({
                path: fullPath,
                fullPage: true,
                timeout: 10000
            });
            logger.info(`Screenshot captured: ${filename}`, {
                plugin: this.currentPortal,
                action: "screenshot"
            });
            return fullPath;
        } catch (error) {
            logger.error(`Failed to capture screenshot: ${error.message}`, {
                plugin: this.currentPortal,
                action: "screenshot",
                success: false
            });
            return null;
        }
    }
}

module.exports = new BrowserManager();
