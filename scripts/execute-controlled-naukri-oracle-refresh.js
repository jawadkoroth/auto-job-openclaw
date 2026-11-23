const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const telegramService = require("../apps/telegram");

(async () => {
    console.log("==================================================");
    console.log("NAUKRI CONTROLLED ORACLE PROFILE REFRESH TEST");
    console.log("Timestamp:", new Date().toISOString());
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ storageState.json not found at:", storageStatePath);
        process.exit(1);
    }

    const evidence = {
        executionHost: "Oracle VM",
        timestamp: new Date().toISOString(),
        profileUrl: "https://www.naukri.com/mnjuser/profile",
        authCheck: {
            status: null,
            candidateName: null,
            authenticated: false
        },
        before: {
            lastUpdatedText: null,
            modDateVal: null,
            headlineText: null,
            headlineLength: 0
        },
        saveAction: {
            editClicked: false,
            textareaFound: false,
            saveButtonClicked: false,
            apiResponse: null
        },
        after: {
            freshContextLoaded: false,
            lastUpdatedText: null,
            modDateVal: null,
            headlineText: null,
            headlineLength: 0,
            headlinePreserved: false,
            freshnessVerified: false
        },
        concurrencyVerified: false,
        screenshotPath: null,
        telegramAlertSent: false,
        overallResult: "FAIL"
    };

    const launchOptions = {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ]
    };

    const contextOptions = {
        storageState: storageStatePath,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: {
            "sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\""
        }
    };

    let browser = await chromium.launch(launchOptions);
    let ctx = await browser.newContext(contextOptions);

    await ctx.addInitScript(() => {
        delete Object.getPrototypeOf(navigator).webdriver;
        window.navigator.chrome = { runtime: {} };
    });

    let page = await ctx.newPage();

    let capturedApiResponse = null;
    page.on("response", async (res) => {
        const u = res.url();
        if (u.includes("resman-aggregator") || u.includes("fullprofiles") || u.includes("resumeHeadline")) {
            try {
                const text = await res.text();
                capturedApiResponse = {
                    url: u,
                    status: res.status(),
                    statusText: res.statusText(),
                    headers: res.headers(),
                    bodyPreview: text ? text.slice(0, 300) : null
                };
            } catch (e) {}
        }
    });

    try {
        // --- STEP 1: Controlled Authentication & Before Evidence ---
        console.log("[1/5] Navigating to Naukri Profile on Oracle VM...");
        const res = await page.goto(evidence.profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);

        evidence.authCheck.status = res ? res.status() : 0;
        const pageTitle = await page.title().catch(() => "");
        console.log(`Page Title: "${pageTitle}" | HTTP Status: ${evidence.authCheck.status}`);

        if (pageTitle.toLowerCase().includes("access denied") || evidence.authCheck.status === 403) {
            throw new Error("Akamai 403 Access Denied during profile navigation.");
        }

        // Read Candidate Name
        const nameLoc = page.locator("span.fullname, .user-name, div.info .name").first();
        if (await nameLoc.count() > 0) {
            evidence.authCheck.candidateName = (await nameLoc.textContent()).trim();
            evidence.authCheck.authenticated = true;
            console.log(`✓ Candidate Name Identified: "${evidence.authCheck.candidateName}"`);
        }

        // Read BEFORE Last Updated
        const beforeLastUpdatedLoc = page.locator(".mode-date-wrap").first();
        if (await beforeLastUpdatedLoc.count() > 0) {
            evidence.before.lastUpdatedText = (await beforeLastUpdatedLoc.textContent()).trim();
        }
        const beforeValLoc = page.locator(".mod-date-val").first();
        if (await beforeValLoc.count() > 0) {
            evidence.before.modDateVal = (await beforeValLoc.textContent()).trim();
        }
        console.log(`✓ BEFORE Profile Last Updated: "${evidence.before.lastUpdatedText}" (val: "${evidence.before.modDateVal}")`);

        // Read BEFORE Resume Headline
        const headlineWidget = page.locator(".resumeHeadline .prefill, .prefill.typ-14Medium").first();
        if (await headlineWidget.count() > 0) {
            evidence.before.headlineText = (await headlineWidget.textContent()).trim();
            evidence.before.headlineLength = evidence.before.headlineText.length;
            console.log(`✓ BEFORE Resume Headline: "${evidence.before.headlineText.slice(0, 60)}..." (${evidence.before.headlineLength} chars)`);
        } else {
            throw new Error("Resume Headline display element not found on profile page.");
        }

        // --- STEP 2: Controlled Headline Save ---
        console.log("\n[2/5] Triggering Controlled Resume Headline Save...");
        const editBtn = page.locator("div.widgetHead:has-text('Resume headline') span.edit, div.widgetHead:has-text('Resume headline') .editOneTheme").first();
        if (await editBtn.count() === 0) {
            throw new Error("Resume Headline edit button not found.");
        }
        await editBtn.click();
        evidence.saveAction.editClicked = true;
        await page.waitForTimeout(2000);

        const textarea = page.locator("#resumeHeadlineTxt, textarea").first();
        if (await textarea.count() === 0) {
            throw new Error("Headline textarea not found after clicking edit.");
        }
        evidence.saveAction.textareaFound = true;

        const currentFieldVal = (await textarea.inputValue()).trim();
        console.log(`✓ Form textarea loaded with existing value (${currentFieldVal.length} chars).`);

        // Refill EXACT existing headline value
        await textarea.fill(evidence.before.headlineText);
        await page.waitForTimeout(1000);

        // Find the specific Save button inside the headline drawer
        const saveBtn = page.locator("form:has(#resumeHeadlineTxt) button[type='submit'], button.btn-dark-ot:visible").first();
        if (await saveBtn.count() === 0) {
            throw new Error("Save button in headline form not found.");
        }

        console.log("Clicking Save button...");
        await saveBtn.click();
        evidence.saveAction.saveButtonClicked = true;
        await page.waitForTimeout(4000);

        evidence.saveAction.apiResponse = capturedApiResponse;
        console.log("✓ Save completed. Intercepted API response:", capturedApiResponse ? `${capturedApiResponse.status} ${capturedApiResponse.url}` : "None intercepted");

        // Save fresh session state from context
        await ctx.storageState({ path: storageStatePath });
        console.log("✓ Saved updated session state to storageState.json");

        await ctx.close().catch(() => {});
        await browser.close().catch(() => {});

        // --- STEP 3: Independent Verification in FRESH Context ---
        console.log("\n[3/5] Launching FRESH Context for Independent AFTER Verification...");
        browser = await chromium.launch(launchOptions);
        ctx = await browser.newContext(contextOptions);

        await ctx.addInitScript(() => {
            delete Object.getPrototypeOf(navigator).webdriver;
            window.navigator.chrome = { runtime: {} };
        });

        page = await ctx.newPage();
        await page.goto(evidence.profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);

        evidence.after.freshContextLoaded = true;

        // Read AFTER Last Updated
        const afterLastUpdatedLoc = page.locator(".mode-date-wrap").first();
        if (await afterLastUpdatedLoc.count() > 0) {
            evidence.after.lastUpdatedText = (await afterLastUpdatedLoc.textContent()).trim();
        }
        const afterValLoc = page.locator(".mod-date-val").first();
        if (await afterValLoc.count() > 0) {
            evidence.after.modDateVal = (await afterValLoc.textContent()).trim();
        }
        console.log(`✓ AFTER Profile Last Updated: "${evidence.after.lastUpdatedText}" (val: "${evidence.after.modDateVal}")`);

        // Read AFTER Headline
        const afterHeadlineWidget = page.locator(".resumeHeadline .prefill, .prefill.typ-14Medium").first();
        if (await afterHeadlineWidget.count() > 0) {
            evidence.after.headlineText = (await afterHeadlineWidget.textContent()).trim();
            evidence.after.headlineLength = evidence.after.headlineText.length;
            console.log(`✓ AFTER Resume Headline: "${evidence.after.headlineText.slice(0, 60)}..." (${evidence.after.headlineLength} chars)`);
        }

        // Integrity check: BEFORE === AFTER
        evidence.after.headlinePreserved = (evidence.before.headlineText === evidence.after.headlineText);
        console.log(`✓ Headline Integrity Verified (BEFORE === AFTER): ${evidence.after.headlinePreserved}`);

        // Freshness verification: "Today"
        evidence.after.freshnessVerified = Boolean(
            (evidence.after.lastUpdatedText && evidence.after.lastUpdatedText.toLowerCase().includes("today")) ||
            (evidence.after.modDateVal && evidence.after.modDateVal.toLowerCase().includes("today"))
        );
        console.log(`✓ Profile Freshness Verified (Updated Today): ${evidence.after.freshnessVerified}`);

        // Capture evidence screenshot
        const screenshotDir = path.join(process.cwd(), "screenshots");
        await fs.ensureDir(screenshotDir);
        const screenshotFile = path.join(screenshotDir, "naukri_oracle_profile_refreshed.png");
        await page.screenshot({ path: screenshotFile, fullPage: false });
        evidence.screenshotPath = screenshotFile;
        console.log(`✓ Evidence screenshot saved to: ${screenshotFile}`);

        // --- STEP 4: Concurrency Lock Check ---
        console.log("\n[4/5] Verifying Concurrency Lock Semantics...");
        const NaukriConcurrencyLock = require("../packages/plugins/naukri/NaukriConcurrencyLock");
        const lock1 = new NaukriConcurrencyLock("test_concurrency.lock");
        const lock2 = new NaukriConcurrencyLock("test_concurrency.lock");
        const acq1 = lock1.acquire();
        const acq2 = lock2.acquire();
        lock1.release();
        const acq3 = lock2.acquire();
        lock2.release();
        console.log(`✓ Concurrency Lock Test: Lock 1 acquired = ${acq1}, Lock 2 blocked = ${!acq2}, Lock 2 after release = ${acq3}`);
        evidence.concurrencyVerified = (acq1 === true && acq2 === false && acq3 === true);

        // --- STEP 5: Telegram Notification & Final Evaluation ---
        console.log("\n[5/5] Sending Verification Telegram Notification...");
        if (evidence.authCheck.authenticated && evidence.after.headlinePreserved && evidence.after.freshnessVerified && evidence.concurrencyVerified) {
            evidence.overallResult = "PASS";
            const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
            const tgMsg = `<b>✓ Naukri Profile Refresh Verified (Oracle VM)</b>\n\n` +
                `• <b>Portal</b>: <code>Naukri</code>\n` +
                `• <b>Status</b>: <code>VERIFIED_SUCCESS</code>\n` +
                `• <b>Host</b>: <code>Oracle VM</code>\n` +
                `• <b>Candidate</b>: <code>${evidence.authCheck.candidateName}</code>\n` +
                `• <b>Headline Preserved</b>: <code>YES (100% Exact)</code>\n` +
                `• <b>Portal Freshness</b>: <code>${evidence.after.lastUpdatedText}</code>\n` +
                `• <b>Freshness Timestamp</b>: <code>Updated Today</code>\n` +
                `• <b>Concurrency Guard</b>: <code>VERIFIED (Single runner lock)</code>\n` +
                `• <b>Time (IST)</b>: <code>${nowIst}</code>`;

            await telegramService.sendMessage(tgMsg).catch(e => console.error("Telegram error:", e.message));
            evidence.telegramAlertSent = true;
            console.log("✓ Telegram verification alert sent successfully.");
        } else {
            console.error("❌ Verification conditions not fully met.");
        }

    } catch (err) {
        console.error("❌ Controlled Profile Refresh Error:", err.message);
        evidence.error = err.message;
    } finally {
        if (ctx) await ctx.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});

        const reportPath = path.join(process.cwd(), "naukri_profile_refresh_evidence.json");
        await fs.writeJson(reportPath, evidence, { spaces: 2 });
        console.log(`\nEvidence written to: ${reportPath}`);
    }

    console.log("\n==================================================");
    console.log("CONTROLLED VERIFICATION RESULT:", evidence.overallResult);
    console.log("==================================================");
})();
