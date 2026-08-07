const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../../../apps/telegram");
const logger = require("../../logger").plugin("linkedin");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LinkedInSessionBootstrap {
    constructor(storageStatePath) {
        this.storageStatePath = storageStatePath || path.join(process.cwd(), "sessions", "linkedin", "storageState.json");
    }

    async bootstrap() {
        const hostName = process.platform === "win32" ? "Windows PC" : "Oracle VM";

        if (!fs.existsSync(this.storageStatePath)) {
            logger.error("❌ storageState.json not found at:", this.storageStatePath);
            await telegramService.sendMessage(
                `<b>⚠️ LinkedIn PC Authentication Required</b>\n\n` +
                `• <b>Portal</b>: <code>LinkedIn</code>\n` +
                `• <b>Status</b>: <code>SESSION_EXPIRED</code>\n` +
                `• <b>Execution Host</b>: <code>${hostName}</code>\n` +
                `• <b>Details</b>: Saved session storageState.json missing.\n` +
                `• <b>Action</b>: Please manually refresh/recreate the authenticated session.`
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
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                storageState: this.storageStatePath
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            page = await context.newPage();

            logger.info("[SessionBootstrap] Navigating to LinkedIn Feed (https://www.linkedin.com/feed/)...");
            let res = await page.goto("https://www.linkedin.com/feed/", {
                waitUntil: "domcontentloaded",
                timeout: 30000
            }).catch(e => {
                logger.warn(`[SessionBootstrap] Navigation warning: ${e.message}`);
                return null;
            });

            await delay(3000);

            const finalUrl = page.url();
            const pageTitle = await page.title().catch(() => "");
            const httpStatus = res ? res.status() : 0;
            const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : "").catch(() => "");

            const isLoginPage = finalUrl.includes("/login") || finalUrl.includes("/uas/login") || finalUrl.includes("/signup") || bodyText.toLowerCase().includes("sign in") || bodyText.toLowerCase().includes("join linkedin");
            const isChallenge = finalUrl.includes("/checkpoint/challenge") || bodyText.toLowerCase().includes("security verification") || bodyText.toLowerCase().includes("verify your identity");
            const isAuthenticated = finalUrl.includes("/feed") || finalUrl.includes("/mynetwork") || finalUrl.includes("/jobs") || bodyText.toLowerCase().includes("messaging") || bodyText.toLowerCase().includes("start a post");

            if (isChallenge) {
                logger.warn("[SessionBootstrap] ⚠️ LinkedIn Security Verification / Challenge detected.");
                await telegramService.sendMessage(
                    `<b>⚠️ LinkedIn PC Challenge Required</b>\n\n` +
                    `• <b>Portal</b>: <code>LinkedIn</code>\n` +
                    `• <b>Status</b>: <code>CHALLENGE_REQUIRED</code>\n` +
                    `• <b>Execution Host</b>: <code>${hostName}</code>\n` +
                    `• <b>Action</b>: Manual verification required via browser.`
                ).catch(() => {});

                return {
                    status: "CHALLENGE_REQUIRED",
                    browser,
                    context,
                    page,
                    httpStatus,
                    finalUrl
                };
            }

            if (isLoginPage) {
                logger.error("[SessionBootstrap] ❌ Session expired. Redirected to login page.");
                await telegramService.sendMessage(
                    `<b>⚠️ LinkedIn PC Authentication Required</b>\n\n` +
                    `• <b>Portal</b>: <code>LinkedIn</code>\n` +
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

            if (isAuthenticated || finalUrl.includes("linkedin.com")) {
                logger.info("[SessionBootstrap] ✓ Authenticated LinkedIn Dashboard/Feed Verified.");
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

            logger.warn(`[SessionBootstrap] ⚠️ Ambiguous page state (URL: ${finalUrl}, Title: ${pageTitle})`);
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
            logger.error(`[SessionBootstrap] Bootstrap error: ${err.message}`);
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

module.exports = LinkedInSessionBootstrap;
