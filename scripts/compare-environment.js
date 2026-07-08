const { chromium } = require("playwright");
const os = require("os");
const path = require("path");
const config = require("../packages/config"); // to get launch args

(async () => {
    console.log("====================================================");
    console.log("             ENVIRONMENT COMPARISON DATA            ");
    console.log("====================================================");
    
    // 1. Node version
    console.log(`Node version:            ${process.version}`);
    
    // 2. Playwright version
    let playwrightVersion = "N/A";
    try {
        playwrightVersion = require("playwright/package.json").version;
    } catch (e) {}
    console.log(`Playwright version:      ${playwrightVersion}`);
    
    // 3. OS and Kernel details
    console.log(`OS Platform:             ${os.platform()}`);
    console.log(`OS Type:                 ${os.type()}`);
    console.log(`OS Release:              ${os.release()}`);
    console.log(`Kernel version:          ${os.version()}`);
    
    // 4. Timezone and Locale
    let timezone = "N/A";
    let locale = "N/A";
    try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch (e) {}
    console.log(`Timezone:                ${timezone}`);
    console.log(`Locale:                  ${locale}`);

    // 5. Browser metrics (executable path, version, launch args)
    let browserVersion = "N/A";
    let browserPath = "N/A";
    let launchArgs = config.browser.args || [];
    
    try {
        browserPath = chromium.executablePath();
        const browser = await chromium.launch({ headless: true });
        browserVersion = browser.version();
        await browser.close();
    } catch (e) {
        browserVersion = "Error: " + e.message;
    }
    
    console.log(`Browser Executable Path: ${browserPath}`);
    console.log(`Chromium version:        ${browserVersion}`);
    console.log(`Launch arguments:        ${JSON.stringify(launchArgs)}`);
    
    // 6. Installed fonts check
    // We can launch Chromium, open a blank page, and query available fonts via document.fonts
    console.log("\nChecking common fonts availability in Chromium...");
    let fontStatus = {};
    try {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        // List of common fonts to check
        const fontsToCheck = [
            "Arial", "Times New Roman", "Courier New", "Georgia", 
            "Verdana", "Trebuchet MS", "Impact", "Comic Sans MS",
            "Helvetica", "Times", "Courier", "Roboto", "Open Sans", 
            "Liberation Sans", "DejaVu Sans", "Nimbus Sans L"
        ];
        
        fontStatus = await page.evaluate((fonts) => {
            const results = {};
            for (const font of fonts) {
                results[font] = document.fonts.check(`12px "${font}"`);
            }
            return results;
        }, fontsToCheck);
        
        await browser.close();
    } catch (e) {
        console.log(`Failed to verify fonts: ${e.message}`);
    }
    
    console.log("Font Availability map:");
    console.log(JSON.stringify(fontStatus, null, 2));
    console.log("====================================================");
})();
