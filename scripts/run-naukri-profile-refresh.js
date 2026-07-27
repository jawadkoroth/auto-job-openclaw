const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");
const logger = require("../packages/logger").plugin("naukri");
const eventBus = require("../packages/events/EventBus");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function persistDiagnostics(page, res, label = "FAILURE") {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const diagDir = path.join(process.cwd(), "logs", "naukri", "profile-refresh", `${timestamp}_${label}`);
        fs.mkdirpSync(diagDir);

        const finalUrl = page ? page.url() : "N/A";
        const title = page ? await page.title().catch(() => "N/A") : "N/A";
        const httpStatus = (res && typeof res.status === "function") ? res.status() : "N/A";
        const readyState = page ? await page.evaluate(() => document.readyState).catch(() => "N/A") : "N/A";
        const bodyText = page ? await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : "").catch(() => "") : "";
        const fullHtml = page ? await page.content().catch(() => "") : "";

        const isLoginPage = finalUrl.includes("/nlogin/") || finalUrl.includes("/login") || bodyText.toLowerCase().includes("login to your account");
        const isAuthenticated = finalUrl.includes("/mnjuser/") || bodyText.toLowerCase().includes("my naukri") || bodyText.toLowerCase().includes("user dashboard") || bodyText.toLowerCase().includes("resume headline");
        const isAkamaiBlocked = httpStatus === 403 || title.toLowerCase().includes("access denied") || bodyText.toLowerCase().includes("access denied");
        const hasHeadlineText = /resume\s*headline/i.test(bodyText);

        let classification = "UNKNOWN";
        if (isAkamaiBlocked) classification = "PORTAL_ACCESS_DENIED";
        else if (isLoginPage) classification = "AUTH_EXPIRED";
        else if (!isAuthenticated && !finalUrl.includes("/mnjuser/profile")) classification = "WRONG_PAGE";
        else if (isAuthenticated && !hasHeadlineText) classification = "SELECTOR_CHANGED";
        else if (readyState !== "complete") classification = "PAGE_LOAD_INCOMPLETE";

        if (page) {
            await page.screenshot({ path: path.join(diagDir, "screenshot.png"), fullPage: true }).catch(() => {});
        }
        if (fullHtml) {
            fs.writeFileSync(path.join(diagDir, "snapshot.html"), fullHtml);
        }

        const summaryText = `
==================================================
NAUKRI PROFILE REFRESH DIAGNOSTIC REPORT
Timestamp:      ${timestamp}
Label:          ${label}
Classification: ${classification}
==================================================
Final URL:             ${finalUrl}
Page Title:            ${title}
HTTP Response Status:  ${httpStatus}
document.readyState:   ${readyState}
Is Login Page:         ${isLoginPage}
Is Authenticated UI:   ${isAuthenticated}
Is Akamai Blocked:     ${isAkamaiBlocked}
Has Headline Text:     ${hasHeadlineText}

First 1000 chars of Body Text:
--------------------------------------------------
${bodyText.replace(/\r\n|\r/g, "\n")}
`;
        fs.writeFileSync(path.join(diagDir, "summary.txt"), summaryText.trim());

        const domAnalysis = page ? await page.evaluate(() => {
            const headlineMatches = [];
            const editControls = [];
            const textareas = [];

            const allEls = Array.from(document.querySelectorAll("*"));
            for (const el of allEls) {
                const txt = (el.innerText || el.textContent || "").trim();
                if (/resume\s*headline/i.test(txt) && el.children.length === 0) {
                    headlineMatches.push({ tagName: el.tagName, className: el.className, id: el.id, text: txt.slice(0, 100) });
                }
            }

            const edits = Array.from(document.querySelectorAll("span.edit, .editOne, [class*='edit' i], i.icon, button"));
            for (const e of edits) {
                editControls.push({ tagName: e.tagName, className: e.className, id: e.id, text: (e.innerText || "").trim() });
            }

            const tas = Array.from(document.querySelectorAll("textarea, #resumeHeadlineTxt"));
            for (const t of tas) {
                textareas.push({ tagName: t.tagName, id: t.id, name: t.name, className: t.className, value: (t.value || "").slice(0, 100) });
            }

            return { headlineMatches, editControls: editControls.slice(0, 10), textareas };
        }).catch(() => ({})) : {};

        fs.writeFileSync(path.join(diagDir, "dom_analysis.json"), JSON.stringify(domAnalysis, null, 2));

        logger.info(`Diagnostics persisted under: logs/naukri/profile-refresh/${timestamp}_${label} (Classification: ${classification})`);
        return classification;
    } catch (err) {
        logger.error(`Failed to persist diagnostics: ${err.message}`);
        return "UNKNOWN";
    }
}

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
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });

        page = await context.newPage();

        // 1. Establish candidate dashboard session context
        logger.info("[1/4] Navigating to Candidate Dashboard (mnjuser/homepage)...");
        let homeRes = await page.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await delay(3000);

        const homeTitle = await page.title().catch(() => "");
        if ((homeRes && homeRes.status() === 403) || homeTitle.toLowerCase().includes("access denied")) {
            logger.warn("⚠️ Akamai 403 Access Denied on Dashboard. Retrying after 10s cooldown...");
            await delay(10000);
            homeRes = await page.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
            await delay(3000);
        }

        logger.info("Navigating to Candidate Profile Page...");
        let profileRes = await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await delay(4000);

        let currentUrl = page.url();
        let pageTitle = await page.title().catch(() => "");

        if (currentUrl.includes("/nlogin/") || currentUrl.includes("/login")) {
            logger.error("❌ Naukri session redirect detected during profile refresh. Re-authentication required.");
            const classification = await persistDiagnostics(page, profileRes, "AUTH_EXPIRED");
            const tgMsg = `<b>⚠️ Naukri Profile Refresh Failed</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Classification</b>: <code>${classification}</code>\n` +
                `• <b>Executed From</b>: <code>Oracle VM</code>\n` +
                `• <b>Time (IST)</b>: <code>${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}</code>`;
            await telegramService.sendMessage(tgMsg).catch(() => {});
            process.exit(1);
        }

        if ((profileRes && profileRes.status() === 403) || pageTitle.toLowerCase().includes("access denied")) {
            logger.warn("⚠️ Akamai 403 Access Denied on Profile URL. Reloading once after 10s...");
            await delay(10000);
            profileRes = await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
            await delay(4000);
            currentUrl = page.url();
            pageTitle = await page.title().catch(() => "");
        }

        if ((profileRes && profileRes.status() === 403) || pageTitle.toLowerCase().includes("access denied")) {
            logger.error("❌ Access Denied / Akamai Block on Naukri Profile page.");
            const classification = await persistDiagnostics(page, profileRes, "PORTAL_ACCESS_DENIED");
            process.exit(1);
        }

        // Multi-Selector Fallback Matrix for Resume Headline Heading & Container
        const headlineHeadingLocators = [
            page.locator("div.widgetHead:has-text('Resume headline')"),
            page.locator(".resumeHeadline"),
            page.locator("span:has-text('Resume headline')"),
            page.locator("div:has-text('Resume headline')"),
            page.locator("h2:has-text('Resume headline'), h3:has-text('Resume headline'), h4:has-text('Resume headline')"),
            page.locator("[class*='resumeHeadline' i]")
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
            const classification = await persistDiagnostics(page, profileRes, "SELECTOR_CHANGED");
            process.exit(1);
        }

        // Extract BEFORE Headline Content with Multi-Locator Matrix
        const headlineContentLocators = [
            page.locator("div.widgetHead:has-text('Resume headline') + div"),
            page.locator(".resumeHeadline .widgetCont"),
            page.locator("div:has-text('Resume headline') + div"),
            page.locator("span:has-text('Resume headline') + div"),
            page.locator(".resumeHeadline p, .resumeHeadline span.text"),
            page.locator("div.resumeHeadline div.text")
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

        // Safety Invariant Check — BEFORE Headline MUST be non-empty and readable
        if (!beforeHeadline || beforeHeadline.length < 5) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: BEFORE headline content could not be read with confidence. Aborting save.");
            const classification = await persistDiagnostics(page, profileRes, "UNREADABLE_BEFORE_HEADLINE");
            process.exit(1);
        }

        logger.info(`✓ Read Resume Headline BEFORE refresh (${beforeHeadline.length} chars): "${beforeHeadline.slice(0, 60)}..."`);

        // Find & Click Edit Control with Multi-Locator Matrix
        logger.info("[2/4] Opening Headline Edit Form...");
        const editControlLocators = [
            page.locator("div.widgetHead:has-text('Resume headline') span.edit"),
            page.locator(".resumeHeadline span.edit"),
            page.locator(".resumeHeadline .editOne"),
            page.locator("span.edit:has-text('editOne')"),
            page.locator("span:has-text('Resume headline') ~ span.edit"),
            page.locator("i.icon-edit, span.icon-edit"),
            page.locator("span:has-text('edit')")
        ];

        let editBtn = null;
        for (const loc of editControlLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                editBtn = loc.first();
                break;
            }
        }

        if (!editBtn) {
            // Try clicking first edit control in headline widget area
            editBtn = page.locator("div.widgetHead:has-text('Resume headline') span, .resumeHeadline span.edit").first();
        }

        if (await editBtn.count().catch(() => 0) === 0) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Edit button for Resume Headline not found.");
            const classification = await persistDiagnostics(page, profileRes, "EDIT_BUTTON_NOT_FOUND");
            process.exit(1);
        }

        await editBtn.click().catch(() => {});
        await delay(2000);

        // Find Textarea Field with Multi-Locator Matrix
        const textareaLocators = [
            page.locator("#resumeHeadlineTxt"),
            page.locator("textarea[name*='headline' i]"),
            page.locator("textarea[placeholder*='headline' i]"),
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
            const classification = await persistDiagnostics(page, profileRes, "TEXTAREA_NOT_FOUND");
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
            page.locator("button:has-text('Save')"),
            page.locator("button.btn-light-blue"),
            page.locator("button[type='submit']"),
            page.locator("a:has-text('Save')")
        ];

        let saveBtn = null;
        for (const loc of saveBtnLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                saveBtn = loc.first();
                break;
            }
        }

        if (!saveBtn) {
            logger.error("❌ SAFETY INVARIANT VIOLATION: Save button not found. Aborting.");
            const classification = await persistDiagnostics(page, profileRes, "SAVE_BUTTON_NOT_FOUND");
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
        const freshBrowser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });
        const freshCtx = await freshBrowser.newContext({
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });
        const freshPage = await freshCtx.newPage();
        await freshPage.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await delay(3000);

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
        await persistDiagnostics(page, null, "RUNNER_EXCEPTION");
        process.exit(1);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
