const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    console.log("==================================================");
    console.log("NAUKRI LOCAL AUTHENTICATED SESSION BOOTSTRAP");
    console.log("==================================================\n");

    const sessionDir = path.join(process.cwd(), "sessions", "naukri");
    await fs.ensureDir(sessionDir);
    const storageStatePath = path.join(sessionDir, "storageState.json");

    console.log("Launching Headed Chromium browser for manual authentication...");
    console.log("Please complete your Naukri login, credentials, OTP, and any security verification in the browser window.\n");

    const browser = await chromium.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 900 }
    });

    const page = await context.newPage();

    console.log("Navigating to https://www.naukri.com/nlogin/login ...");
    await page.goto("https://www.naukri.com/nlogin/login", { waitUntil: "domcontentloaded" });

    console.log("Waiting for observable authenticated candidate account UI (up to 3 minutes)...");

    const loggedInSelector = "a:has-text('View profile'), a:has-text('Logout'), div.nI-gNb-drawer, .nI-gNb-drawer__icon-img, .nI-gNb-header__user-name, img[src*='avatar'], .user-name, a[href*='/mnj/profile']";

    let authenticated = false;
    try {
        await page.waitForSelector(loggedInSelector, { timeout: 180000 });
        authenticated = true;
        console.log("✓ Authenticated candidate account UI detected!");
    } catch (e) {
        console.warn("⚠️ Timed out waiting for candidate authentication UI.");
    }

    const finalUrl = page.url();
    const isProfileUrl = finalUrl.includes("/mnj/profile") || finalUrl.includes("/nI-gNb");

    if (authenticated || isProfileUrl) {
        await context.storageState({ path: storageStatePath });
        const storageData = await fs.readJson(storageStatePath);
        const cookiesCount = storageData.cookies ? storageData.cookies.length : 0;
        const originsCount = storageData.origins ? storageData.origins.length : 0;

        console.log("\n==================================================");
        console.log("SESSION BOOTSTRAP SUCCESSFUL");
        console.log("==================================================");
        console.log(`Authenticated:              YES`);
        console.log(`Account State Verified:     YES`);
        console.log(`Final URL:                  ${finalUrl}`);
        console.log(`Cookies Saved:              ${cookiesCount}`);
        console.log(`Origins Saved:              ${originsCount}`);
        console.log(`StorageState Path:          ${storageStatePath}`);
        console.log("==================================================\n");
    } else {
        console.log("\n==================================================");
        console.log("SESSION BOOTSTRAP FAILED / PENDING");
        console.log("==================================================");
        console.log(`Authenticated:              NO`);
        console.log(`Account State Verified:     NO`);
        console.log(`Final URL:                  ${finalUrl}`);
        console.log("==================================================\n");
    }

    await browser.close().catch(() => {});
})();
