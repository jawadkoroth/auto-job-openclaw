const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../logger");
const contextManager = require("./ContextManager");
const path = require("path");
const fs = require("fs-extra");

class BrowserInstance {
    /**
     * @param {string} portalName 
     */
    constructor(portalName) {
        this.portalName = portalName.toLowerCase();
        this.context = null;
        this.intentionalClose = false;
        this.screenshotDir = path.join(process.cwd(), "screenshots");
        fs.ensureDirSync(this.screenshotDir);
    }

    /**
     * Launch persistent context for this instance
     * @returns {Promise<import("playwright").BrowserContext>}
     */
    async launch() {
        if (this.context) {
            if (await this.healthCheck()) {
                return this.context;
            }
            await this.close();
        }

        const sessionPath = contextManager.getContextPath(this.portalName);
        logger.browser.info(`Launching isolated BrowserInstance for: ${this.portalName}`);

        try {
            this.context = await chromium.launchPersistentContext(sessionPath, {
                headless: config.browser.headless,
                channel: "chrome",
                viewport: config.browser.viewport,
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                args: config.browser.args,
                timeout: config.browser.timeout
            });

            this.context.setDefaultTimeout(config.browser.timeout);

            // Log browser details to session metadata
            const browserVersion = this.context.browser() ? this.context.browser().version() : "Chromium";
            await contextManager.updateMetadata(this.portalName, {
                browserVersion,
                sessionHealth: "healthy",
                lastRefresh: new Date().toISOString()
            });

            this.context.on("close", () => {
                if (this.intentionalClose) return;
                logger.browser.warn(`BrowserInstance context for ${this.portalName} closed unexpectedly.`);
                this.context = null;
                contextManager.updateMetadata(this.portalName, { sessionHealth: "crashed" }).catch(() => {});
            });

            return this.context;
        } catch (error) {
            logger.browser.error(`Failed to launch browser for ${this.portalName}: ${error.message}`);
            await contextManager.updateMetadata(this.portalName, { sessionHealth: "failed" }).catch(() => {});
            throw error;
        }
    }

    /**
     * Retrieve current page or build a new one
     * @returns {Promise<import("playwright").Page>}
     */
    async newPage() {
        if (!this.context) {
            await this.launch();
        }
        const pages = this.context.pages();
        if (pages.length > 0) {
            return pages[0];
        }
        return await this.context.newPage();
    }

    /**
     * Check if context is active and responsive
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
        } catch (e) {
            logger.browser.warn(`Health check failure on BrowserInstance for ${this.portalName}: ${e.message}`);
            return false;
        }
    }

    /**
     * Terminate context and re-initialize
     * @returns {Promise<import("playwright").BrowserContext>}
     */
    async restart() {
        logger.browser.info(`Restarting BrowserInstance context for: ${this.portalName}`);
        await this.close();
        return await this.launch();
    }

    /**
     * Gracefully terminate instance context
     */
    async close() {
        if (this.context) {
            logger.browser.info(`Closing BrowserInstance context for: ${this.portalName}`);
            try {
                this.intentionalClose = true;
                await this.context.close();
            } catch (err) {
                logger.browser.error(`Failed closing context for ${this.portalName}: ${err.message}`);
            } finally {
                this.context = null;
                this.intentionalClose = false;
            }
        }
    }

    /**
     * Take screenshot of active tab
     * @param {import("playwright").Page} page 
     * @param {string} label 
     */
    async takeScreenshot(page, label) {
        if (!page) return null;
        const filename = `${Date.now()}-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
        const fullPath = path.join(this.screenshotDir, filename);
        try {
            await page.screenshot({ path: fullPath, fullPage: true, timeout: 10000 });
            logger.browser.info(`Screenshot captured for ${this.portalName}: ${filename}`);
            return fullPath;
        } catch (err) {
            logger.browser.error(`Failed to capture screenshot for ${this.portalName}: ${err.message}`);
            return null;
        }
    }
}

module.exports = BrowserInstance;
