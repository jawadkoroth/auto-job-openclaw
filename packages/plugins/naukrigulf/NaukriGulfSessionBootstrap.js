const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../../../apps/telegram");
const logger = require("../../logger").plugin("naukrigulf");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NaukriGulfSessionBootstrap {
    constructor(storageStatePath) {
        this.storageStatePath = storageStatePath || path.join(process.cwd(), "sessions", "naukrigulf", "storageState.json");
    }

    async bootstrap() {
        const hostName = process.platform === "win32" ? "Windows PC" : "Oracle VM";

        if (!fs.existsSync(this.storageStatePath)) {
            logger.error("❌ storageState.json not found at:", this.storageStatePath);
            await telegramService.sendMessage(
                `<b>⚠️ NaukriGulf Authentication Required</b>\n\n` +
                `• <b>Portal</b>: <code>NaukriGulf</code>\n` +
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

            logger.info("[NaukriGulfBootstrap] Navigating to Candidate CV (mnj/userProfile/myCV)...");
            let res = await page.goto("https://www.naukrigulf.com/mnj/userProfile/myCV", {
                waitUntil: "domcontentloaded",
                timeout: 30000
            }).catch(e => {
                logger.warn(`[NaukriGulfBootstrap] Navigation warning: ${e.message}`);
                return null;
            });

            await delay(4000);

            const finalUrl = page.url();
            const pageTitle = await page.title().catch(() => "");
            const httpStatus = res ? res.status() : 0;
            const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : "").catch(() => "");

            const isAkamaiBlocked = httpStatus === 403 || pageTitle.toLowerCase().includes("access denied") || bodyText.toLowerCase().includes("access denied");
            const isLoginPage = finalUrl.includes("/login") || finalUrl.includes("/nlogin/") || bodyText.toLowerCase().includes("sign in to your account");
            const isAuthenticated = finalUrl.includes("/mnj/userProfile/") || bodyText.toLowerCase().includes("my cv") || bodyText.toLowerCase().includes("cv headline");

            if (isAkamaiBlocked) {
                logger.warn("[NaukriGulfBootstrap] ⚠️ Akamai 403 Access Denied detected during session bootstrap.");
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
                logger.error("[NaukriGulfBootstrap] ❌ Session expired. Redirected to login page.");
                await telegramService.sendMessage(
                    `<b>⚠️ NaukriGulf Authentication Required</b>\n\n` +
                    `• <b>Portal</b>: <code>NaukriGulf</code>\n` +
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
                logger.info("[NaukriGulfBootstrap] ✓ Authenticated Candidate CV Page Verified.");
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

            logger.warn(`[NaukriGulfBootstrap] ⚠️ Ambiguous page state (URL: ${finalUrl}, Title: ${pageTitle})`);
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
            logger.error(`[NaukriGulfBootstrap] Bootstrap error: ${err.message}`);
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

module.exports = NaukriGulfSessionBootstrap;

