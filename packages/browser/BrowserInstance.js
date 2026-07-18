const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../logger");
const contextManager = require("./ContextManager");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");

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
            const isLinux = os.platform() === "linux";
            const userAgent = isLinux ? undefined : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

            const isHeadfulAuth = process.env.HEADFUL_AUTH_SETUP === "true";
            const launchOptions = {
                headless: isHeadfulAuth ? false : config.browser.headless,
                viewport: config.browser.viewport,
                userAgent: userAgent,
                timezoneId: "Asia/Kolkata",
                locale: "en-IN",
                extraHTTPHeaders: {
                    "Accept-Language": "en-IN,en;q=0.9"
                },
                args: config.browser.args,
                timeout: config.browser.timeout
            };

            logger.browser.info(`Complete browser launch options: ${JSON.stringify(launchOptions, null, 2)}`);

            this.context = await chromium.launchPersistentContext(sessionPath, launchOptions);

            // Load portable storageState if it exists (Task 2)
            const storageStatePath = path.join(sessionPath, "storageState.json");
            if (fs.existsSync(storageStatePath)) {
                try {
                    const state = fs.readJsonSync(storageStatePath);
                    if (state.cookies && state.cookies.length > 0) {
                        await this.context.addCookies(state.cookies);
                    }
                    if (state.origins && state.origins.length > 0) {
                        await this.context.addInitScript((origins) => {
                            for (const originState of origins) {
                                if (window.location.origin === originState.origin) {
                                    for (const item of originState.localStorage) {
                                        window.localStorage.setItem(item.name, item.value);
                                    }
                                }
                            }
                        }, state.origins);
                    }
                    logger.browser.info(`[${this.portalName}] Successfully loaded storageState.json into persistent context.`);
                } catch (err) {
                    logger.browser.error(`[${this.portalName}] Failed to load storageState.json: ${err.message}`);
                }
            }

            // Configure init scripts to ensure standard window/navigator properties
            await this.context.addInitScript(() => {
                // Ensure window.chrome exists
                if (!window.chrome) {
                    window.chrome = {
                        runtime: {},
                        loadTimes: function() {},
                        csi: function() {},
                        app: {}
                    };
                }
                
                // Ensure navigator.plugins is populated
                if (!navigator.plugins || navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => {
                            const mockPlugins = [
                                { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "Chrome PDF Viewer", filename: "mhjfbgoafeeigndgjbbefjhhakeomjia", description: "Portable Document Format" },
                                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" }
                            ];
                            mockPlugins.item = function(index) { return this[index]; };
                            mockPlugins.namedItem = function(name) { return this.find(p => p.name === name); };
                            mockPlugins.refresh = function() {};
                            return mockPlugins;
                        }
                    });
                }

                // Ensure navigator.languages returns ["en-IN", "en"]
                Object.defineProperty(navigator, 'languages', {
                    get: () => ["en-IN", "en"]
                });
            });

            this.context.setDefaultTimeout(config.browser.timeout);

            // Log browser details to session metadata
            const browserVersion = this.context.browser() ? this.context.browser().version() : "Chromium";
            const currentMeta = await contextManager.getMetadata(this.portalName);
            await contextManager.updateMetadata(this.portalName, {
                browserVersion,
                sessionHealth: currentMeta.sessionHealth === "healthy" ? "healthy" : "unknown",
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
                
                // Refresh session storage state on close (Task 3)
                if (this.portalName === "hirist") {
                    try {
                        const sessionPath = contextManager.getContextPath(this.portalName);
                        const storageStatePath = path.join(sessionPath, "storageState.json");
                        const pages = this.context.pages();
                        const metadata = await contextManager.getMetadata(this.portalName).catch(() => ({}));
                        if (pages.length > 0 && metadata.sessionHealth === "healthy") {
                            const tempPath = storageStatePath + ".tmp";
                            await this.context.storageState({ path: tempPath });
                            if (fs.existsSync(tempPath)) {
                                fs.moveSync(tempPath, storageStatePath, { overwrite: true });
                                logger.browser.info(`[${this.portalName}] Auto-exported/refreshed storageState.json upon close.`);
                            }
                        } else {
                            logger.browser.info(`[${this.portalName}] Skipping storageState auto-export on close (session health is not healthy).`);
                        }
                    } catch (err) {
                        logger.browser.error(`[${this.portalName}] Failed to auto-export storageState.json upon close: ${err.message}`);
                    }
                }
                
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
