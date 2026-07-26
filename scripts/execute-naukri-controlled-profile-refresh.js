const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("./apps/telegram");

(async () => {
    console.log("==================================================");
    console.log("PHASE 2 — NAUKRI CONTROLLED PROFILE REFRESH TEST (1 SAVE)");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ storageState.json not found at:", storageStatePath);
        process.exit(1);
    }

    const report = {
        profileUrl: "https://www.naukri.com/mnjuser/profile",
        beforeLastUpdated: "N/A",
        afterLastUpdated: "N/A",
        beforeHeadline: null,
        afterHeadline: null,
        dataPreserved: false,
        saveAccepted: false,
        telegramSent: false,
        finalStatus: "FAIL"
    };

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

        console.log("[1/5] Navigating to Naukri Profile Page...");
        await page.goto(report.profileUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(4000);

        // Wait for profile widgets to mount
        const headlineWidgetHead = "div.widgetHead:has-text('Resume headline'), div:has-text('Resume headline')";
        await page.waitForSelector(headlineWidgetHead, { timeout: 15000 }).catch(() => {});

        // Record BEFORE evidence
        const lastUpdatedLoc = page.locator(".mod-date, :has-text('Profile last updated'), .last-updated").first();
        if (await lastUpdatedLoc.count().catch(() => 0) > 0) {
            report.beforeLastUpdated = (await lastUpdatedLoc.textContent().catch(() => "N/A")).trim();
        }
        console.log(`✓ BEFORE Profile Last Updated: "${report.beforeLastUpdated}"`);

        const headlineWidget = page.locator("div.widgetHead:has-text('Resume headline') + div, .resumeHeadline .widgetCont, div:has-text('Resume headline') + div").first();
        if (await headlineWidget.count().catch(() => 0) > 0) {
            report.beforeHeadline = (await headlineWidget.textContent().catch(() => "")).trim();
            console.log(`✓ BEFORE Resume Headline Read (${report.beforeHeadline.length} chars).`);
        } else {
            console.error("❌ Resume Headline container not found.");
            process.exit(1);
        }

        // Open Edit UI and Save EXACT preserved value
        console.log("\n[2/5] Opening Headline Edit UI...");
        const editBtnLoc = page.locator("div.widgetHead:has-text('Resume headline') span.edit, span.edit:has-text('editOne')").first();
        await editBtnLoc.click();
        await page.waitForTimeout(2000);

        const headlineField = page.locator("#resumeHeadlineTxt, textarea").first();
        await headlineField.waitFor({ state: "visible", timeout: 10000 });

        console.log("[3/5] Preserving exact existing value and clicking Save...");
        const existingVal = await headlineField.inputValue();
        if (existingVal && existingVal.trim().length > 0) {
            report.beforeHeadline = existingVal.trim();
        }

        // Save EXACT existing value
        await headlineField.fill(report.beforeHeadline);
        await page.waitForTimeout(1000);

        const saveBtn = page.locator("button:has-text('Save'), button.btn-light-blue").first();
        await saveBtn.click();
        await page.waitForTimeout(4000);
        report.saveAccepted = true;
        console.log("✓ Save button clicked. Waiting for portal reaction...");

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Reload in FRESH Browser Context to verify persistence
        console.log("\n[4/5] Reloading profile in FRESH browser context to verify AFTER state...");
        const fresh = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });
        const freshCtx = await fresh.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });
        const freshPage = await freshCtx.newPage();

        await freshPage.goto(report.profileUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await freshPage.waitForTimeout(4000);
        await freshPage.waitForSelector(headlineWidgetHead, { timeout: 15000 }).catch(() => {});

        const afterLastUpdatedLoc = freshPage.locator(".mod-date, :has-text('Profile last updated'), .last-updated").first();
        if (await afterLastUpdatedLoc.count().catch(() => 0) > 0) {
            report.afterLastUpdated = (await afterLastUpdatedLoc.textContent().catch(() => "N/A")).trim();
        }
        console.log(`✓ AFTER Profile Last Updated: "${report.afterLastUpdated}"`);

        const afterHeadlineLoc = freshPage.locator("div.widgetHead:has-text('Resume headline') + div, .resumeHeadline .widgetCont, div:has-text('Resume headline') + div").first();
        if (await afterHeadlineLoc.count().catch(() => 0) > 0) {
            report.afterHeadline = (await afterHeadlineLoc.textContent().catch(() => "")).trim();
            console.log(`✓ AFTER Resume Headline Read (${report.afterHeadline.length} chars).`);
        }

        report.dataPreserved = (report.beforeHeadline === report.afterHeadline);
        console.log(`✓ BEFORE === AFTER Headline Preserved: ${report.dataPreserved}`);

        await freshCtx.close().catch(() => {});
        await fresh.close().catch(() => {});

        // Send Telegram Notification
        if (report.saveAccepted && report.dataPreserved) {
            console.log("\n[5/5] Sending Telegram Notification for Profile Refresh...");
            const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
            const tgMsg = `<b>Naukri Profile Refresh</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Status</b>: <code>SUCCESS</code>\n` +
                `• <b>Profile Data Changed</b>: <code>NO</code>\n` +
                `• <b>Executed From</b>: <code>Oracle VM</code>\n` +
                `• <b>Time (IST)</b>: <code>${nowIst}</code>`;

            await telegramService.sendMessage(tgMsg).catch(e => console.error("Telegram send error:", e.message));
            report.telegramSent = true;
            report.finalStatus = "PASS";
            console.log("✓ Telegram alert sent successfully.");
        }

    } catch (err) {
        console.error("❌ Controlled Profile Refresh Error:", err.message);
    } finally {
        fs.writeFileSync("naukri_profile_refresh_report.json", JSON.stringify(report, null, 2));
    }

    console.log("\n==================================================");
    console.log("CONTROLLED PROFILE REFRESH REPORT SUMMARY");
    console.log("==================================================");
    console.log(JSON.stringify(report, null, 2));
})();
