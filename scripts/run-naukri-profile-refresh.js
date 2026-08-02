const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("naukri");
const eventBus = require("../packages/events/EventBus");

const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const NaukriConcurrencyLock = require("../packages/plugins/naukri/NaukriConcurrencyLock");
const NaukriDiagnostics = require("../packages/plugins/naukri/NaukriDiagnostics");
const oraclePersistence = require("../packages/persistence/NaukriOraclePersistence");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    logger.info("==================================================");
    logger.info("[LIFECYCLE] START");
    logger.info("NAUKRI HARDENED PROFILE REFRESH RUNNER");
    logger.info(`Execution Host: ${executionHost}`);
    logger.info("Execution Time: " + new Date().toISOString());
    logger.info("==================================================\n");

    const lock = new NaukriConcurrencyLock("naukri_profile_refresh.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ naukri_profile_refresh runner is already executing. Exiting as SKIPPED_ALREADY_RUNNING.");
        process.exit(0);
    }

    await oraclePersistence.flushOutbox().catch(() => {});

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();
    logger.info("[LIFECYCLE] PLAYWRIGHT_LAUNCHED");

    if (boot.status === "SESSION_EXPIRED") {
        logger.error("❌ Profile Refresh halted: Session expired. Re-authentication required.");
        lock.release();
        process.exit(1);
    }

    if (boot.status === "AKAMAI_BLOCKED") {
        logger.error("❌ Profile Refresh halted: Akamai 403 Access Denied during bootstrap.");
        await NaukriDiagnostics.persist(boot.page, null, "BOOTSTRAP_AKAMAI_BLOCKED", "AKAMAI_TEMPORARY_BLOCK");
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        logger.error(`❌ Profile Refresh halted: Bootstrap failed with status ${boot.status}`);
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    const { browser, context, page } = boot;

    try {
        logger.info("[1/4] Navigating to Candidate Profile Page...");
        let profileRes = await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await delay(4000);
        logger.info("[LIFECYCLE] PROFILE_LOADED");

        let currentUrl = page.url();
        let pageTitle = await page.title().catch(() => "");

        if (currentUrl.includes("/nlogin/") || currentUrl.includes("/login")) {
            logger.error("❌ Session redirect detected during profile navigation.");
            await NaukriDiagnostics.persist(page, profileRes, "PROFILE_AUTH_EXPIRED", "SESSION_EXPIRED");
            const tgMsg = `<b>⚠️ Naukri Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Classification</b>: <code>SESSION_EXPIRED</code>\n` +
                `• <b>Executed From</b>: <code>${executionHost}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
            process.exit(1);
        }

        if ((profileRes && profileRes.status() === 403) || pageTitle.toLowerCase().includes("access denied")) {
            logger.error("❌ Akamai 403 Access Denied on Naukri Profile page.");
            await NaukriDiagnostics.persist(page, profileRes, "PROFILE_AKAMAI_BLOCKED", "AKAMAI_TEMPORARY_BLOCK");
            const tgMsg = `<b>⚠️ Naukri Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Classification</b>: <code>AKAMAI_TEMPORARY_BLOCK</code>\n` +
                `• <b>Executed From</b>: <code>${executionHost}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
            process.exit(1);
        }

        // Heading Fallback Matrix
        const headlineHeadingLocators = [
            page.locator("div.widgetHead:has-text('Resume headline')"),
            page.locator(".resumeHeadline"),
            page.locator("span:has-text('Resume headline')"),
            page.locator("div:has-text('Resume headline')")
        ];

        let foundHeading = null;
        for (const loc of headlineHeadingLocators) {
            if (await loc.count().catch(() => 0) > 0) {
                foundHeading = loc.first();
                break;
            }
        }

        if (!foundHeading) {
            logger.warn("⚠️ Resume headline heading delay. Scrolling & waiting 5s...");
            await page.evaluate(() => window.scrollBy(0, 300));
            await delay(5000);
            for (const loc of headlineHeadingLocators) {
                if (await loc.count().catch(() => 0) > 0) {
                    foundHeading = loc.first();
                    break;
                }
            }
        }

        if (!foundHeading) {
            logger.error("❌ Resume Headline container heading not found across all fallbacks.");
            await NaukriDiagnostics.persist(page, profileRes, "HEADING_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        // Read BEFORE Headline
        const headlineContentLocators = [
            page.locator("div.widgetHead:has-text('Resume headline') + div"),
            page.locator(".resumeHeadline .widgetCont"),
            page.locator("div:has-text('Resume headline') + div"),
            page.locator(".resumeHeadline p, .resumeHeadline span.text")
        ];

        let beforeHeadline = "";
        for (const loc of headlineContentLocators) {
            if (await loc.count().catch(() => 0) > 0) {
                const txt = (await loc.first().textContent().catch(() => "")).trim();
                if (txt.length > 5) {
                    beforeHeadline = txt;
                    break;
                }
            }
        }

        if (!beforeHeadline || beforeHeadline.length < 5) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: BEFORE headline content unreadable. Aborting.");
            await NaukriDiagnostics.persist(page, profileRes, "UNREADABLE_BEFORE_HEADLINE", "SELECTOR_CHANGED");
            process.exit(1);
        }

        logger.info(`✓ Read Resume Headline BEFORE refresh (${beforeHeadline.length} chars): "${beforeHeadline.slice(0, 60)}..."`);
        logger.info("[LIFECYCLE] HEADLINE_READ");

        // Click Edit
        logger.info("[2/4] Opening Headline Edit Form...");
        const editControlLocators = [
            page.locator("div.widgetHead:has-text('Resume headline') span.edit"),
            page.locator(".resumeHeadline span.edit"),
            page.locator(".resumeHeadline .editOne"),
            page.locator("i.icon-edit, span.icon-edit")
        ];

        let editBtn = null;
        for (const loc of editControlLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                editBtn = loc.first();
                break;
            }
        }

        if (!editBtn) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Edit button for Resume Headline not found.");
            await NaukriDiagnostics.persist(page, profileRes, "EDIT_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        await editBtn.click().catch(() => {});
        await delay(2000);

        // Find Textarea
        const textareaLocators = [
            page.locator("#resumeHeadlineTxt"),
            page.locator("textarea[name*='headline' i]"),
            page.locator("textarea")
        ];

        let headlineField = null;
        for (const loc of textareaLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                headlineField = loc.first();
                break;
            }
        }

        if (!headlineField) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Headline textarea field not visible after clicking edit.");
            await NaukriDiagnostics.persist(page, profileRes, "TEXTAREA_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        const formVal = await headlineField.inputValue().catch(() => "");
        if (formVal && formVal.trim().length >= 5) {
            beforeHeadline = formVal.trim();
        }

        logger.info("[3/4] Preserving exact existing value and saving profile...");
        await headlineField.fill(beforeHeadline);
        await delay(1000);

        const saveBtnLocators = [
            page.locator("button.btn-dark-ot:has-text('Save')"),
            page.locator("button[type='submit']:has-text('Save')"),
            page.locator("button:has-text('Save')"),
            page.locator(".action button"),
            page.locator("button.btn-light-blue")
        ];

        let saveBtn = null;
        for (const loc of saveBtnLocators) {
            const count = await loc.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
                const item = loc.nth(i);
                if (await item.isVisible().catch(() => false)) {
                    saveBtn = item;
                    break;
                }
            }
            if (saveBtn) break;
        }

        if (!saveBtn) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Save button not found.");
            await NaukriDiagnostics.persist(page, profileRes, "SAVE_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        await saveBtn.click();
        await delay(4000);

        // Save refreshed storageState back to session path
        await context.storageState({ path: storageStatePath }).catch(() => {});
        logger.info("✓ Updated sessions/naukri/storageState.json with refreshed tokens.");

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Step 4: Post-Save Verification in Fresh Browser Context
        logger.info("[4/4] Verifying Post-Save Headline Integrity in Fresh Context (BEFORE === AFTER)...");
        const freshBoot = await bootstrapHelper.bootstrap();
        if (freshBoot.status !== "AUTHENTICATED" || !freshBoot.page) {
            logger.error("❌ Post-save verification context bootstrap failed.");
            if (freshBoot.browser) await freshBoot.browser.close().catch(() => {});
            process.exit(1);
        }

        const freshPage = freshBoot.page;
        await freshPage.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await delay(4000);

        let afterHeadline = "";
        for (const loc of headlineContentLocators) {
            if (await freshPage.locator(loc).count().catch(() => 0) > 0) {
                const txt = (await freshPage.locator(loc).first().textContent().catch(() => "")).trim();
                if (txt.length > 5) {
                    afterHeadline = txt;
                    break;
                }
            }
        }

        if (!afterHeadline && await freshPage.locator("#resumeHeadlineTxt, textarea").count().catch(() => 0) > 0) {
            afterHeadline = (await freshPage.locator("#resumeHeadlineTxt, textarea").first().inputValue().catch(() => "")).trim();
        }

        await freshBoot.context.close().catch(() => {});
        await freshBoot.browser.close().catch(() => {});

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
                `• <b>Executed From</b>: <code>${executionHost}</code>`;
            await telegramService.sendMessage(tgAlert).catch(() => {});
            process.exit(1);
        }

        logger.info("✓ Headline Integrity Verified (BEFORE === AFTER).");
        logger.info("[LIFECYCLE] VERIFICATION_PASSED");

        const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        logger.info("✓ Naukri Profile Refresh Run Complete Successfully.");
        logger.info("[LIFECYCLE] FINISHED");

    } catch (err) {
        logger.error(`❌ Naukri Profile Refresh Error: ${err.message}`);
        await NaukriDiagnostics.persist(page, null, "RUNNER_EXCEPTION");
        process.exit(1);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await oraclePersistence.flushOutbox().catch(() => {});
        lock.release();
    }
})();
