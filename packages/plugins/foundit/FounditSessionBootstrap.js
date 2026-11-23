const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../../../apps/telegram");
const logger = require("../../logger").plugin("foundit");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FounditSessionBootstrap {
    constructor(storageStatePath) {
        this.storageStatePath = storageStatePath || path.join(process.cwd(), "sessions", "foundit", "storageState.json");
    }

    async bootstrap() {
        const hostName = process.platform === "win32" ? "Windows PC" : "Oracle VM";

        if (!fs.existsSync(this.storageStatePath)) {
            logger.error("❌ storageState.json not found at:", this.storageStatePath);
            await telegramService.sendMessage(
                `<b>⚠️ Foundit Authentication Required</b>\n\n` +
                `• <b>Portal</b>: <code>Foundit</code>\n` +
                `• <b>Status</b>: <code>SESSION_EXPIRED</code>\n` +
                `• <b>Execution Host</b>: <code>${hostName}</code>\n` +
                `• <b>Details</b>: Saved session storageState.json missing.\n` +
                `• <b>Action</b>: Please bootstrap/recreate the authenticated session.`
            ).catch(() => {});

            return {
                status: "SESSION_EXPIRED",
                browser: null,
                context: null,
                page: null,
                error: "storageState.json missing"
            };
        }

        let browser = null;
        let context = null;
        let page = null;

        try {
            const launchOptions = {
                headless: true,
                args: [
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled"
                ]
            };

            try {
                browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
            } catch (chromeErr) {
                browser = await chromium.launch(launchOptions);
            }

            context = await browser.newContext({
                viewport: { width: 1440, height: 900 },
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                storageState: this.storageStatePath,
                extraHTTPHeaders: {
                    "sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"Windows\""
                }
            });

            await context.addInitScript(() => {
                delete Object.getPrototypeOf(navigator).webdriver;
                window.navigator.chrome = { runtime: {} };
            });

            page = await context.newPage();

            logger.info("[FounditBootstrap] Navigating to Candidate Profile (seeker/profile)...");
            let res = await page.goto("https://www.foundit.in/seeker/profile", {
                waitUntil: "domcontentloaded",
                timeout: 30000
            }).catch(e => {
                logger.warn(`[FounditBootstrap] Navigation warning: ${e.message}`);
                return null;
            });

            await delay(4000);

            const finalUrl = page.url();
            const pageTitle = await page.title().catch(() => "");
            const httpStatus = res ? res.status() : 0;
            const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : "").catch(() => "");

            const isAkamaiBlocked = httpStatus === 403 || pageTitle.toLowerCase().includes("access denied") || bodyText.toLowerCase().includes("access denied");
            const isLoginPage = finalUrl.includes("/login") || finalUrl.includes("/rio/login") || bodyText.toLowerCase().includes("login via password");
            const isAuthenticated = finalUrl.includes("/seeker/") || bodyText.toLowerCase().includes("profile summary") || bodyText.toLowerCase().includes("jawad koroth");

            if (isAkamaiBlocked) {
                logger.warn("[FounditBootstrap] ⚠️ Akamai 403 Access Denied detected during session bootstrap.");
                return {
                    status: "AKAMAI_BLOCKED",
                    browser,
                    context,
                    page,
                    httpStatus,
                    finalUrl,
                    pageTitle
                };
            }

            if (isLoginPage) {
                logger.error("[FounditBootstrap] ❌ Session expired. Redirected to login page.");
                await telegramService.sendMessage(
                    `<b>⚠️ Foundit Authentication Required</b>\n\n` +
                    `• <b>Portal</b>: <code>Foundit</code>\n` +
                    `• <b>Status</b>: <code>SESSION_EXPIRED</code>\n` +
                    `• <b>Execution Host</b>: <code>${hostName}</code>\n` +
                    `• <b>Details</b>: Authenticated session redirected to login.\n` +
                    `• <b>Action</b>: Please manually refresh/recreate the authenticated session.`
                ).catch(() => {});

                return {
                    status: "SESSION_EXPIRED",
                    browser,
                    context,
                    page: null,
                    httpStatus,
                    finalUrl
                };
            }

            if (isAuthenticated) {
                logger.info("[FounditBootstrap] ✓ Authenticated Candidate Profile Page Verified.");
                return {
                    status: "AUTHENTICATED",
                    browser,
                    context,
                    page,
                    httpStatus,
                    finalUrl,
                    pageTitle
                };
            }

            logger.warn(`[FounditBootstrap] ⚠️ Ambiguous page state (URL: ${finalUrl}, Title: ${pageTitle})`);
            return {
                status: "NAVIGATION_FAILED",
                browser,
                context,
                page,
                httpStatus,
                finalUrl,
                pageTitle
            };

        } catch (err) {
            logger.error(`[FounditBootstrap] Bootstrap error: ${err.message}`);
            return {
                status: "NAVIGATION_FAILED",
                browser,
                context,
                page: null,
                error: err.message
            };
        }
    }
}

module.exports = FounditSessionBootstrap;
