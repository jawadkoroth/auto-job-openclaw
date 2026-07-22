process.env.HEADFUL_AUTH_SETUP = "true";

const BrowserInstance = require("../packages/browser/BrowserInstance");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const contextManager = require("../packages/browser/ContextManager");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "linkedin";
    console.log("==================================================");
    console.log("LINKEDIN PORTABLE AUTH BOOTSTRAP");
    console.log("==================================================");
    console.log("1. Launching headed Chromium browser with unique temporary profile...");

    const browserInstance = new BrowserInstance(portal);
    let isAuthed = false;
    let isExported = "NO";
    let cookiesCount = 0;
    let originsCount = 0;
    let page;

    try {
        await browserInstance.launch();
        page = await browserInstance.newPage();

        console.log("2. Navigating to LinkedIn Login ONCE...");
        await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });

        console.log("\n======================================================================");
        console.log("MANUAL AUTHENTICATION INSTRUCTIONS:");
        console.log("- Please enter your credentials, OTP, CAPTCHA, or 2FA manually.");
        console.log("- Do NOT close the browser window manually.");
        console.log("- The script will poll authentication state READ-ONLY.");
        console.log("- Once logged in, the script will wait 4s, export storageState.json,");
        console.log("  update session health, and close automatically.");
        console.log("======================================================================\n");

        console.log("3. Polling authentication state read-only...");
        
        const maxWaitMs = 15 * 60 * 1000; // 15 minutes max
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitMs) {
            await page.waitForTimeout(2000);

            if (await page.isClosed()) {
                console.log("⚠️ Browser window was closed before authentication could be verified.");
                break;
            }

            const authState = await externalApplicationRouter.classifyLinkedInAuth(page);
            if (authState === "AUTHENTICATED") {
                console.log("✅ Genuine LinkedIn authentication detected!");
                console.log("4. Waiting 4 seconds for session stabilization...");
                await page.waitForTimeout(4000);
                isAuthed = true;
                break;
            }
        }

        if (isAuthed) {
            const sessionDir = contextManager.getContextPath(portal);
            const storageStatePath = path.join(sessionDir, "storageState.json");
            
            console.log(`5. Exporting portable storageState to: ${storageStatePath}`);
            await page.context().storageState({ path: storageStatePath });

            if (await fs.pathExists(storageStatePath)) {
                isExported = "YES";
                const state = await fs.readJson(storageStatePath).catch(() => ({}));
                cookiesCount = state.cookies ? state.cookies.length : 0;
                originsCount = state.origins ? state.origins.length : 0;

                await contextManager.updateMetadata(portal, {
                    sessionHealth: "healthy",
                    lastLogin: new Date().toISOString()
                });
                console.log("6. Marked LinkedIn session metadata as healthy.");
            }
        } else {
            console.log("❌ Authentication timeout or failed.");
            await contextManager.updateMetadata(portal, {
                sessionHealth: "unhealthy"
            });
        }
    } catch (err) {
        console.error(`❌ [Error during LinkedIn Auth Bootstrap] ${err.message}`);
    } finally {
        console.log("7. Closing browser and cleaning up temporary profile...");
        await browserInstance.close();
        console.log("8. Browser closed.");
    }

    console.log("\n==================================================");
    console.log("LINKEDIN PORTABLE AUTH BOOTSTRAP RESULT");
    console.log("==================================================");
    console.log(`Portal: ${portal}`);
    console.log(`Authentication: ${isAuthed ? "PASS" : "FAIL"}`);
    console.log(`StorageState Exported: ${isExported}`);
    console.log(`Cookies Exported: ${cookiesCount}`);
    console.log(`Origins Exported: ${originsCount}`);
    console.log("==================================================\n");
})();
