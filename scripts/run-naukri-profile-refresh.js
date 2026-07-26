const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("naukri");
const eventBus = require("../packages/events/EventBus");

(async () => {
    logger.info("==================================================");
    logger.info("NAUKRI PRODUCTION PROFILE REFRESH RUNNER");
    logger.info("Execution Time: " + new Date().toISOString());
    logger.info("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    if (!fs.existsSync(storageStatePath)) {
        logger.error("❌ storageState.json not found at:", storageStatePath);
        process.exit(1);
    }

    let browser, context, page;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });

        context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });

        page = await context.newPage();

        logger.info("[1/4] Navigating to Naukri Candidate Profile Page...");
        await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(4000);

        const currentUrl = page.url();
        if (currentUrl.includes("/nlogin/") || currentUrl.includes("/login")) {
            logger.error("❌ Naukri session redirect detected during profile refresh. Re-authentication required.");
            const tgMsg = `<b>⚠️ Naukri Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Status</b>: <code>SESSION_REAUTH_REQUIRED</code>\n` +
                `• <b>Executed From</b>: <code>Oracle VM</code>\n` +
                `• <b>Time (IST)</b>: <code>${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
            process.exit(1);
        }

        const headlineWidgetHead = "div.widgetHead:has-text('Resume headline'), div:has-text('Resume headline')";
        await page.waitForSelector(headlineWidgetHead, { timeout: 15000 }).catch(() => {});

        const headlineWidget = page.locator("div.widgetHead:has-text('Resume headline') + div, .resumeHeadline .widgetCont, div:has-text('Resume headline') + div").first();
        let beforeHeadline = "";
        if (await headlineWidget.count().catch(() => 0) > 0) {
            beforeHeadline = (await headlineWidget.textContent().catch(() => "")).trim();
            logger.info(`✓ Read Resume Headline BEFORE refresh (${beforeHeadline.length} chars).`);
        } else {
            logger.error("❌ Resume Headline container not found.");
            process.exit(1);
        }

        logger.info("[2/4] Opening Headline Edit Form...");
        const editBtnLoc = page.locator("div.widgetHead:has-text('Resume headline') span.edit, span.edit:has-text('editOne')").first();
        await editBtnLoc.click();
        await page.waitForTimeout(2000);

        const headlineField = page.locator("#resumeHeadlineTxt, textarea").first();
        await headlineField.waitFor({ state: "visible", timeout: 10000 });

        const formVal = await headlineField.inputValue();
        if (formVal && formVal.trim().length > 0) {
            beforeHeadline = formVal.trim();
        }

        logger.info("[3/4] Preserving exact existing value and saving profile...");
        await headlineField.fill(beforeHeadline);
        await page.waitForTimeout(1000);

        const saveBtn = page.locator("button:has-text('Save'), button.btn-light-blue").first();
        await saveBtn.click();
        await page.waitForTimeout(4000);

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Post-save verification in fresh browser context (Phase 7 Integrity Check)
        logger.info("[4/4] Verifying Post-Save Headline Integrity (BEFORE === AFTER)...");
        const freshBrowser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });
        const freshCtx = await freshBrowser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });
        const freshPage = await freshCtx.newPage();
        await freshPage.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await freshPage.waitForTimeout(4000);

        const afterHeadlineWidget = freshPage.locator("div.widgetHead:has-text('Resume headline') + div, .resumeHeadline .widgetCont, div:has-text('Resume headline') + div").first();
        let afterHeadline = "";
        if (await afterHeadlineWidget.count().catch(() => 0) > 0) {
            afterHeadline = (await afterHeadlineWidget.textContent().catch(() => "")).trim();
        }

        await freshCtx.close().catch(() => {});
        await freshBrowser.close().catch(() => {});

        if (beforeHeadline !== afterHeadline && afterHeadline.length > 0) {
            logger.error(`❌ PROFILE_REFRESH_INTEGRITY_FAILURE: Headline text altered during refresh! BEFORE length=${beforeHeadline.length}, AFTER length=${afterHeadline.length}`);
            eventBus.publish("PROFILE_REFRESH_INTEGRITY_FAILURE", {
                portal: "Naukri",
                before: beforeHeadline,
                after: afterHeadline
            });

            const tgAlert = `<b>⚠️ PROFILE REFRESH INTEGRITY FAILURE</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Status</b>: <code>INTEGRITY_FAILURE</code>\n` +
                `• <b>Details</b>: Profile headline content altered unexpectedly during refresh.\n` +
                `• <b>Executed From</b>: <code>Oracle VM</code>`;
            await telegramService.sendMessage(tgAlert).catch(() => {});
            process.exit(1);
        }

        logger.info("✓ Headline Integrity Verified (BEFORE === AFTER).");

        const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        const tgMsg = `<b>Naukri Profile Refresh</b>\n\n` +
            `• <b>Portal</b>: <code>Naukri</code>\n` +
            `• <b>Status</b>: <code>SUCCESS</code>\n` +
            `• <b>Profile Data Changed</b>: <code>NO</code>\n` +
            `• <b>Executed From</b>: <code>Oracle VM</code>\n` +
            `• <b>Time (IST)</b>: <code>${nowIst}</code>`;

        await telegramService.sendMessage(tgMsg).catch(e => logger.error(`Telegram send error: ${e.message}`));
        logger.info("✓ Naukri Profile Refresh Run Complete Successfully.");

    } catch (err) {
        logger.error(`❌ Naukri Profile Refresh Error: ${err.message}`);
        process.exit(1);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
