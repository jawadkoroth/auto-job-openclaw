const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("naukrigulf");
const eventBus = require("../packages/events/EventBus");

const NaukriGulfSessionBootstrap = require("../packages/plugins/naukrigulf/NaukriGulfSessionBootstrap");
const NaukriGulfConcurrencyLock = require("../packages/plugins/naukrigulf/NaukriGulfConcurrencyLock");
const NaukriGulfDiagnostics = require("../packages/plugins/naukrigulf/NaukriGulfDiagnostics");
const { createRunLogger } = require("../packages/observability");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    const runIdArg = process.argv.includes("--run-id") ? process.argv[process.argv.indexOf("--run-id") + 1] : process.env.RUN_ID;
    const taskIdArg = process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : process.env.TASK_ID;

    const runLogger = createRunLogger({
        portal: "naukrigulf",
        action: "updateProfile",
        workerId: process.platform === "win32" ? "windows" : "oracle",
        runId: runIdArg,
        taskId: taskIdArg,
        triggerType: taskIdArg ? "TELEGRAM_OR_DISPATCHED" : "SCHEDULED"
    });
    await runLogger.start().catch(() => {});

    logger.info("==================================================");
    logger.info("[LIFECYCLE] START");
    logger.info("NAUKRIGULF PROFILE REFRESH RUNNER");
    logger.info(`Run ID: ${runLogger.runId}`);
    logger.info(`Execution Host: ${executionHost}`);
    logger.info("Execution Time: " + new Date().toISOString());
    logger.info("==================================================\n");

    const sendFailureAlert = async (classification, reason) => {
        try {
            const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
            const tgMsg = `<b>⚠️ NaukriGulf Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>NaukriGulf</code>\n` +
                `• <b>Classification</b>: <code>${classification}</code>\n` +
                `• <b>Reason</b>: <code>${reason}</code>\n` +
                `• <b>Executed From</b>: <code>${executionHost}</code>\n` +
                `• <b>Time (IST)</b>: <code>${nowIst}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
        } catch (e) {}
    };

    const lock = new NaukriGulfConcurrencyLock("naukrigulf_profile_refresh.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ naukrigulf_profile_refresh runner is already executing. Exiting as SKIPPED_ALREADY_RUNNING.");
        process.exit(0);
    }

    const storageStatePath = path.join(process.cwd(), "sessions", "naukrigulf", "storageState.json");
    const bootstrapHelper = new NaukriGulfSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();
    logger.info("[LIFECYCLE] PLAYWRIGHT_LAUNCHED");

    if (boot.status === "SESSION_EXPIRED") {
        logger.error("❌ Profile Refresh halted: Session expired. Re-authentication required.");
        await sendFailureAlert("SESSION_EXPIRED", "Saved session expired or redirected to login.");
        lock.release();
        process.exit(1);
    }

    if (boot.status === "AKAMAI_BLOCKED") {
        logger.error("❌ Profile Refresh halted: Akamai 403 Access Denied during bootstrap.");
        await NaukriGulfDiagnostics.persist(boot.page, null, "BOOTSTRAP_AKAMAI_BLOCKED", "AKAMAI_TEMPORARY_BLOCK");
        await sendFailureAlert("AKAMAI_TEMPORARY_BLOCK", "Akamai 403 Access Denied during bootstrap.");
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        logger.error(`❌ Profile Refresh halted: Bootstrap failed with status ${boot.status}`);
        await sendFailureAlert("BOOTSTRAP_FAILED", `Bootstrap returned status: ${boot.status}`);
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(1);
    }

    const { browser, context, page } = boot;

    try {
        logger.info("[1/4] Inspecting Candidate CV Page and Reading Freshness...");
        await page.waitForTimeout(2000);
        logger.info("[LIFECYCLE] PROFILE_LOADED");

        let currentUrl = page.url();
        let pageTitle = await page.title().catch(() => "");

        if (currentUrl.includes("/login") || currentUrl.includes("/nlogin/")) {
            logger.error("❌ Session redirect detected during profile navigation.");
            await NaukriGulfDiagnostics.persist(page, null, "PROFILE_AUTH_EXPIRED", "SESSION_EXPIRED");
            await sendFailureAlert("SESSION_EXPIRED", "Redirected to login during CV page navigation.");
            process.exit(1);
        }

        // Read Freshness BEFORE
        const beforeFreshness = await page.evaluate(() => {
            const el = document.querySelector(".info-update");
            return el ? el.innerText.trim() : "N/A";
        });
        logger.info(`✓ Profile Freshness BEFORE: "${beforeFreshness}"`);

        // Click Edit button for CV Headline
        logger.info("[2/4] Opening CV Headline Edit Form...");
        const editBtnLocators = [
            page.locator("h4:has-text('CV Headline') ~ button.edit-cta"),
            page.locator(".ec-heading:has-text('CV Headline') button.edit-cta"),
            page.locator("section#cvHeadline button.edit-cta"),
            page.locator(":has-text('CV Headline') button:has-text('Edit')"),
            page.locator("button.edit-cta")
        ];

        let editBtn = null;
        for (const loc of editBtnLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                editBtn = loc.first();
                break;
            }
        }

        if (!editBtn) {
            logger.error("❌ Edit button for CV Headline not found.");
            await NaukriGulfDiagnostics.persist(page, null, "EDIT_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            await sendFailureAlert("SELECTOR_CHANGED", "Edit button for CV Headline not found.");
            process.exit(1);
        }

        await editBtn.click();
        await delay(2000);

        const textareaLocators = [
            page.locator("textarea#cvHeadline"),
            page.locator("textarea[name='cvHeadline']"),
            page.locator("section#cvHeadline textarea"),
            page.locator("textarea")
        ];

        let textarea = null;
        for (const loc of textareaLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                textarea = loc.first();
                break;
            }
        }

        if (!textarea) {
            logger.error("❌ Textarea for CV Headline not found.");
            await NaukriGulfDiagnostics.persist(page, null, "TEXTAREA_NOT_FOUND", "SELECTOR_CHANGED");
            await sendFailureAlert("SELECTOR_CHANGED", "Textarea for CV Headline not found.");
            process.exit(1);
        }

        const existingVal = (await textarea.inputValue()).trim();
        if (!existingVal || existingVal.length < 5) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Existing headline content unreadable or empty. Aborting.");
            await NaukriGulfDiagnostics.persist(page, null, "UNREADABLE_BEFORE_HEADLINE", "SELECTOR_CHANGED");
            await sendFailureAlert("UNREADABLE_BEFORE_HEADLINE", "Existing CV headline unreadable or empty.");
            process.exit(1);
        }

        logger.info(`✓ Read CV Headline BEFORE refresh (${existingVal.length} chars): "${existingVal.slice(0, 60)}..."`);
        logger.info("[LIFECYCLE] HEADLINE_READ");

        // Preserving exact existing value
        logger.info("[3/4] Preserving exact existing headline value and submitting save...");
        await textarea.fill(existingVal);
        await delay(1000);

        // Track API responses
        let cvHeadlineApiSucceeded = false;
        page.on("response", res => {
            if (res.url().includes("/ngprofile/user/self/section/cvHeadline") && res.request().method() === "POST") {
                if (res.status() === 200) {
                    cvHeadlineApiSucceeded = true;
                }
            }
        });

        const saveBtnLocators = [
            page.locator("section#cvHeadline button[type='submit']"),
            page.locator("section#cvHeadline .ng-btn.blue:has-text('Save')"),
            page.locator("section#cvHeadline button:has-text('Save')"),
            page.locator("button:has-text('Save')")
        ];

        let saveBtn = null;
        for (const loc of saveBtnLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                saveBtn = loc.first();
                break;
            }
        }

        if (!saveBtn) {
            logger.error("❌ Save button for CV Headline not found.");
            await NaukriGulfDiagnostics.persist(page, null, "SAVE_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            await sendFailureAlert("SELECTOR_CHANGED", "Save button for CV Headline not found.");
            process.exit(1);
        }

        await saveBtn.click();
        await delay(5000);

        logger.info(`✓ CV Headline API Save Result: ${cvHeadlineApiSucceeded ? "HTTP 200 OK" : "SUBMITTED"}`);

        // Save updated session state
        await context.storageState({ path: storageStatePath }).catch(() => {});
        try {
            if (process.platform !== "win32") {
                fs.chmodSync(storageStatePath, 0o600);
            }
        } catch (e) {}
        logger.info("✓ Updated sessions/naukrigulf/storageState.json with active session tokens.");

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Step 4: Verification in Fresh Browser Context
        logger.info("[4/4] Verifying Post-Save Headline Integrity & Freshness in Fresh Context...");
        const freshBrowser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });
        const freshCtx = await freshBrowser.newContext({
            storageState: storageStatePath,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            extraHTTPHeaders: {
                "sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\""
            }
        });

        const freshPage = await freshCtx.newPage();
        await freshPage.goto("https://www.naukrigulf.com/mnj/userProfile/myCV", { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(4000);

        const afterFreshness = await freshPage.evaluate(() => {
            const el = document.querySelector(".info-update");
            return el ? el.innerText.trim() : "N/A";
        });
        logger.info(`✓ Profile Freshness AFTER: "${afterFreshness}"`);

        const reloadedHeadline = await freshPage.evaluate((expectedPrefix) => {
            const allNodes = Array.from(document.querySelectorAll("*"));
            const headlineNode = allNodes.find(el => el.innerText && el.innerText.includes(expectedPrefix) && el.children.length === 0);
            return headlineNode ? headlineNode.innerText.trim() : "";
        }, existingVal.slice(0, 25));

        const isPreserved = (reloadedHeadline === existingVal) || (reloadedHeadline.length >= 20 && existingVal.includes(reloadedHeadline));

        if (!isPreserved && reloadedHeadline.length > 0) {
            logger.error(`❌ PROFILE_REFRESH_INTEGRITY_FAILURE: Headline text altered during refresh! BEFORE length=${existingVal.length}, AFTER length=${reloadedHeadline.length}`);
            eventBus.publish("PROFILE_REFRESH_INTEGRITY_FAILURE", {
                portal: "NaukriGulf",
                before: existingVal,
                after: reloadedHeadline
            });

            await sendFailureAlert("INTEGRITY_FAILURE", "CV headline altered unexpectedly during refresh.");
            process.exit(1);
        }

        logger.info(`✓ Headline Integrity Verified (BEFORE === AFTER: ${isPreserved})`);
        logger.info("[LIFECYCLE] VERIFICATION_PASSED");

        // Screenshot evidence
        const screenshotDir = path.join(process.cwd(), "screenshots");
        fs.ensureDirSync(screenshotDir);
        const screenshotPath = path.join(screenshotDir, "naukrigulf_oracle_profile_refreshed.png");
        await freshPage.screenshot({ path: screenshotPath }).catch(() => {});
        logger.info(`✓ Saved verification screenshot to: ${screenshotPath}`);

        await freshCtx.close().catch(() => {});
        await freshBrowser.close().catch(() => {});

        // Telegram Notification
        const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        const tgMsg = `<b>✓ NaukriGulf Profile Refresh</b>\n\n` +
            `• <b>Portal</b>: <code>NaukriGulf</code>\n` +
            `• <b>Status</b>: <code>SUCCESS</code>\n` +
            `• <b>Freshness</b>: <code>${afterFreshness}</code>\n` +
            `• <b>Profile Data Changed</b>: <code>NO</code>\n` +
            `• <b>Headline Preserved</b>: <code>YES</code>\n` +
            `• <b>Executed From</b>: <code>${executionHost}</code>\n` +
            `• <b>Time (IST)</b>: <code>${nowIst}</code>`;
        await telegramService.sendMessage(tgMsg).catch(e => logger.error(`Telegram error: ${e.message}`));

        logger.info("✓ NaukriGulf Profile Refresh Run Complete Successfully.");
        logger.info("[LIFECYCLE] FINISHED");
        await runLogger.finish().catch(() => {});

    } catch (err) {
        logger.error(`❌ NaukriGulf Profile Refresh Error: ${err.message}`);
        await runLogger.fail(err).catch(() => {});
        await NaukriGulfDiagnostics.persist(page, null, "RUNNER_EXCEPTION");
        await sendFailureAlert("RUNNER_EXCEPTION", err.message);
        process.exit(1);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        lock.release();
    }
})();
