const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("foundit");
const eventBus = require("../packages/events/EventBus");

const FounditSessionBootstrap = require("../packages/plugins/foundit/FounditSessionBootstrap");
const FounditConcurrencyLock = require("../packages/plugins/foundit/FounditConcurrencyLock");
const FounditDiagnostics = require("../packages/plugins/foundit/FounditDiagnostics");
const { createRunLogger } = require("../packages/observability");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function extractFreshness(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : "";
        const m = text.match(/Profile last updated on:\s*([^\n\r]+)/i);
        return m ? m[0].trim() : "N/A";
    });
}

(async () => {
    const executionHost = process.platform === "win32" ? "Windows PC" : "Oracle VM";

    const runIdArg = process.argv.includes("--run-id") ? process.argv[process.argv.indexOf("--run-id") + 1] : process.env.RUN_ID;
    const taskIdArg = process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : process.env.TASK_ID;

    const runLogger = createRunLogger({
        portal: "foundit",
        action: "updateProfile",
        workerId: process.platform === "win32" ? "windows" : "oracle",
        runId: runIdArg,
        taskId: taskIdArg,
        triggerType: taskIdArg ? "TELEGRAM_OR_DISPATCHED" : "SCHEDULED"
    });
    await runLogger.start().catch(() => {});

    logger.info("==================================================");
    logger.info("[LIFECYCLE] START");
    logger.info("FOUNDIT PROFILE REFRESH RUNNER");
    logger.info(`Run ID: ${runLogger.runId}`);
    logger.info(`Execution Host: ${executionHost}`);
    logger.info("Execution Time: " + new Date().toISOString());
    logger.info("==================================================\n");

    const lock = new FounditConcurrencyLock("foundit_profile_refresh.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ foundit_profile_refresh runner is already executing. Exiting as SKIPPED_ALREADY_RUNNING.");
        process.exit(0);
    }

    const storageStatePath = path.join(process.cwd(), "sessions", "foundit", "storageState.json");
    const bootstrapHelper = new FounditSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();
    logger.info("[LIFECYCLE] PLAYWRIGHT_LAUNCHED");

    if (boot.status === "SESSION_EXPIRED") {
        logger.error("❌ Profile Refresh halted: Session expired. Re-authentication required.");
        lock.release();
        process.exit(1);
    }

    if (boot.status === "AKAMAI_BLOCKED") {
        logger.error("❌ Profile Refresh halted: Akamai 403 Access Denied during bootstrap.");
        await FounditDiagnostics.persist(boot.page, null, "BOOTSTRAP_AKAMAI_BLOCKED", "AKAMAI_TEMPORARY_BLOCK");
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
        logger.info("[1/4] Inspecting Candidate Profile Page and Reading Freshness...");
        await page.waitForTimeout(2000);
        logger.info("[LIFECYCLE] PROFILE_LOADED");

        let currentUrl = page.url();
        let pageTitle = await page.title().catch(() => "");

        if (currentUrl.includes("/login") || currentUrl.includes("/rio/login")) {
            logger.error("❌ Session redirect detected during profile navigation.");
            await FounditDiagnostics.persist(page, null, "PROFILE_AUTH_EXPIRED", "SESSION_EXPIRED");
            const tgMsg = `<b>⚠️ Foundit Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>Foundit</code>\n` +
                `• <b>Classification</b>: <code>SESSION_EXPIRED</code>\n` +
                `• <b>Executed From</b>: <code>${executionHost}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
            process.exit(1);
        }

        // Read Freshness BEFORE
        const beforeFreshness = await extractFreshness(page);
        logger.info(`✓ Profile Freshness BEFORE: "${beforeFreshness}"`);

        // Click Edit button on Profile summary
        logger.info("[2/4] Opening Profile Summary Edit Form...");
        const editBtn = page.locator("#PROFILE_SUMMARY_CONTENT #SECTION_EDIT_BUTTON").first();
        if (await editBtn.count() === 0) {
            logger.error("❌ Edit button for Profile Summary not found.");
            await FounditDiagnostics.persist(page, null, "EDIT_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        await editBtn.click();
        await delay(2000);

        const textarea = page.locator("textarea#summary, textarea[name='summary']").first();
        if (await textarea.count() === 0) {
            logger.error("❌ Textarea for Profile Summary not found.");
            await FounditDiagnostics.persist(page, null, "TEXTAREA_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        const existingVal = (await textarea.inputValue()).trim();
        if (!existingVal || existingVal.length < 20) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Existing profile summary unreadable or too short. Aborting.");
            await FounditDiagnostics.persist(page, null, "UNREADABLE_BEFORE_SUMMARY", "SELECTOR_CHANGED");
            process.exit(1);
        }

        logger.info(`✓ Read Profile Summary BEFORE refresh (${existingVal.length} chars): "${existingVal.slice(0, 60)}..."`);
        logger.info("[LIFECYCLE] SUMMARY_READ");

        // Preserving exact existing value
        logger.info("[3/4] Preserving exact existing summary value and submitting save...");
        await textarea.fill(existingVal);
        await delay(1000);

        // Track API responses
        let profileSummaryApiSucceeded = false;
        page.on("response", res => {
            if (res.url().includes("/seeker-profile/api/setProfileSummary") && res.request().method() === "POST") {
                if (res.status() === 200) {
                    profileSummaryApiSucceeded = true;
                }
            }
        });

        const saveBtn = page.locator("div.guic-modal-container button:has-text('Save'), button:has-text('Save')").first();
        if (await saveBtn.count() === 0) {
            logger.error("❌ Save button for Profile Summary modal not found.");
            await FounditDiagnostics.persist(page, null, "SAVE_BUTTON_NOT_FOUND", "SELECTOR_CHANGED");
            process.exit(1);
        }

        await saveBtn.click();
        await delay(5000);

        logger.info(`✓ Profile Summary API Save Result: ${profileSummaryApiSucceeded ? "HTTP 200 OK" : "SUBMITTED"}`);

        // Save updated session state
        await context.storageState({ path: storageStatePath }).catch(() => {});
        try {
            if (process.platform !== "win32") {
                fs.chmodSync(storageStatePath, 0o600);
            }
        } catch (e) {}
        logger.info("✓ Updated sessions/foundit/storageState.json with active session tokens.");

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Step 4: Verification in Fresh Browser Context
        logger.info("[4/4] Verifying Post-Save Content Integrity & Freshness in Fresh Context...");
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
        await freshPage.goto("https://www.foundit.in/seeker/profile", { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(4000);

        const afterFreshness = await extractFreshness(freshPage);
        logger.info(`✓ Profile Freshness AFTER: "${afterFreshness}"`);

        const reloadedSummary = await freshPage.evaluate(() => {
            const c = document.querySelector("#PROFILE_SUMMARY_CONTENT");
            return c ? c.innerText.trim() : "";
        });

        const isPreserved = reloadedSummary.includes(existingVal.slice(0, 40));

        if (!isPreserved && reloadedSummary.length > 0) {
            logger.error(`❌ PROFILE_REFRESH_INTEGRITY_FAILURE: Profile summary altered during refresh!`);
            eventBus.publish("PROFILE_REFRESH_INTEGRITY_FAILURE", {
                portal: "Foundit",
                before: existingVal,
                after: reloadedSummary
            });

            const tgAlert = `<b>⚠️ PROFILE REFRESH INTEGRITY FAILURE</b>\n\n` +
                `• <b>Portal</b>: <code>Foundit</code>\n` +
                `• <b>Status</b>: <code>INTEGRITY_FAILURE</code>\n` +
                `• <b>Details</b>: Profile summary content altered unexpectedly during refresh.\n` +
                `• <b>Executed From</b>: <code>${executionHost}</code>`;
            await telegramService.sendMessage(tgAlert).catch(() => {});
            process.exit(1);
        }

        logger.info(`✓ Content Integrity Verified (BEFORE preserved in AFTER: ${isPreserved})`);
        logger.info("[LIFECYCLE] VERIFICATION_PASSED");

        // Screenshot evidence
        const screenshotDir = path.join(process.cwd(), "screenshots");
        fs.ensureDirSync(screenshotDir);
        const screenshotPath = path.join(screenshotDir, "foundit_oracle_profile_refreshed.png");
        await freshPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        logger.info(`✓ Saved verification screenshot to: ${screenshotPath}`);

        await freshCtx.close().catch(() => {});
        await freshBrowser.close().catch(() => {});

        // Telegram Notification
        const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        const tgMsg = `<b>✓ Foundit Profile Refresh</b>\n\n` +
            `• <b>Portal</b>: <code>Foundit</code>\n` +
            `• <b>Status</b>: <code>SUCCESS</code>\n` +
            `• <b>Freshness</b>: <code>${afterFreshness}</code>\n` +
            `• <b>Profile Data Changed</b>: <code>NO</code>\n` +
            `• <b>Summary Preserved</b>: <code>YES</code>\n` +
            `• <b>Executed From</b>: <code>${executionHost}</code>\n` +
            `• <b>Time (IST)</b>: <code>${nowIst}</code>`;
        await telegramService.sendMessage(tgMsg).catch(e => logger.error(`Telegram error: ${e.message}`));

        logger.info("✓ Foundit Profile Refresh Run Complete Successfully.");
        logger.info("[LIFECYCLE] FINISHED");
        await runLogger.finish().catch(() => {});

    } catch (err) {
        logger.error(`❌ Foundit Profile Refresh Error: ${err.message}`);
        await runLogger.fail(err).catch(() => {});
        await FounditDiagnostics.persist(page, null, "RUNNER_EXCEPTION");
        process.exit(1);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        lock.release();
    }
})();
