const path = require("path");
const fs = require("fs-extra");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("linkedin");

const LinkedInSessionBootstrap = require("../packages/plugins/linkedin/LinkedInSessionBootstrap");
const LinkedInConcurrencyLock = require("../packages/plugins/linkedin/LinkedInConcurrencyLock");
const oraclePersistence = require("../packages/plugins/linkedin/LinkedInPersistence");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    logger.info("==================================================");
    logger.info("LINKEDIN PROFILE REFRESH RUNNER");
    logger.info(`Execution Host: ${executionHost}`);
    logger.info("Execution Time: " + new Date().toISOString());
    logger.info("==================================================\n");

    const lock = new LinkedInConcurrencyLock("linkedin_profile_refresh.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ linkedin_profile_refresh runner is already executing. Exiting cleanly.");
        process.exit(0);
    }

    await oraclePersistence.flushOutbox().catch(() => {});

    const storageStatePath = path.join(process.cwd(), "sessions", "linkedin", "storageState.json");
    const bootstrapHelper = new LinkedInSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        logger.error(`❌ Profile refresh failed with session status ${boot.status}`);
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    const { browser, page } = boot;

    try {
        logger.info("Navigating to Candidate Profile Feed to refresh session timestamp...");
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        logger.info("✓ Session timestamp successfully refreshed.");
        const tgMsg = `<b>✓ LinkedIn Session Refreshed</b>\n\n` +
            `• <b>Portal</b>: <code>LinkedIn</code>\n` +
            `• <b>Host</b>: <code>${executionHost}</code>\n` +
            `• <b>Status</b>: <code>ACTIVE_SESSION</code>`;
        await telegramService.sendMessage(tgMsg).catch(() => {});

    } catch (err) {
        logger.error(`Profile refresh error: ${err.message}`);
    } finally {
        await browser.close().catch(() => {});
        lock.release();
    }
})();
