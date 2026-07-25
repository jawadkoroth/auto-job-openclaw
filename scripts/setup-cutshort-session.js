const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT LOCAL AUTHENTICATION SETUP");
    console.log("==================================================\n");
    console.log("1. Opening headed Chromium browser at https://cutshort.io");
    console.log("2. Please log into your Cutshort candidate account in the opened browser.");
    console.log("3. The script will automatically detect successful authentication,");
    console.log("   verify account state, and export sessions/cutshort/storageState.json.\n");

    const sessionDir = path.join(process.cwd(), "sessions", "cutshort");
    await fs.ensureDir(sessionDir);
    const storageStatePath = path.join(sessionDir, "storageState.json");

    const context = await chromium.launchPersistentContext(sessionDir, {
        headless: false,
        viewport: { width: 1440, height: 900 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.goto("https://cutshort.io/jobs", { waitUntil: "domcontentloaded" });

    console.log("Waiting for interactive candidate login...");

    let authenticated = false;
    let pollAttempts = 0;
    const maxPolls = 120; // 10 minutes max timeout (5s interval)

    while (!authenticated && pollAttempts < maxPolls) {
        await page.waitForTimeout(5000);
        pollAttempts++;

        try {
            const currentUrl = page.url();
            const pageTitle = await page.title().catch(() => "");
            
            // Check UI indicators for authenticated session
            const userAvatar = await page.locator("a[href*='/user/'], a[href*='/profile'], [class*='profile'], [class*='avatar'], [class*='user-name'], a:has-text('Logout')").count().catch(() => 0);
            const loginBtns = await page.locator("a:has-text('Login'), button:has-text('Login'), a:has-text('Sign In')").count().catch(() => 0);

            const isAuthUrl = currentUrl.includes("/dashboard") || currentUrl.includes("/user/") || currentUrl.includes("/my-applications") || currentUrl.includes("/jobs");

            if (userAvatar > 0 || (isAuthUrl && loginBtns === 0 && !currentUrl.includes("/login"))) {
                authenticated = true;
                console.log("\n✅ Authenticated Cutshort account UI detected!");
                console.log(`   URL: ${currentUrl}`);
                console.log(`   Title: "${pageTitle}"`);
                break;
            } else {
                if (pollAttempts % 4 === 0) {
                    console.log(`   Still waiting for login... (${pollAttempts * 5}s elapsed)`);
                }
            }
        } catch (e) {
            // Ignore transient page navigation errors during manual login
        }
    }

    if (authenticated) {
        // Export Playwright storage state
        await context.storageState({ path: storageStatePath });
        
        const stateObj = await fs.readJson(storageStatePath);
        const cookieCount = stateObj.cookies ? stateObj.cookies.length : 0;
        const originCount = stateObj.origins ? stateObj.origins.length : 0;

        console.log("\n==================================================");
        console.log("CUTSHORT LOCAL SESSION CREATED");
        console.log("==================================================");
        console.log("Authenticated:          YES");
        console.log("Account State Verified: YES");
        console.log(`Storage State:          ${storageStatePath}`);
        console.log(`Cookies Saved:          ${cookieCount}`);
        console.log(`Origins Saved:          ${originCount}`);
        console.log("==================================================\n");

        console.log("Session saved successfully. Closing browser in 5 seconds...");
        await page.waitForTimeout(5000);
    } else {
        console.error("❌ Authentication timeout: No authenticated session detected within 10 minutes.");
    }

    await context.close();
})();
