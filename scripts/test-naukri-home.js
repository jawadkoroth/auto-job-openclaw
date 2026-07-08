const BrowserInstance = require("../packages/browser/BrowserInstance");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    console.log("Starting Naukri home test using BrowserInstance...");
    const browserInstance = new BrowserInstance("naukri");
    
    try {
        const context = await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        console.log("Navigating to https://www.naukri.com/ ...");
        let response = null;
        try {
            response = await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
        } catch (gotoErr) {
            console.error("page.goto navigation failed:", gotoErr.message);
        }
        
        console.log("Waiting 5 seconds for page to settle...");
        await page.waitForTimeout(5000);
        
        const finalUrl = page.url();
        const pageTitle = await page.title().catch(() => "N/A");
        const html = await page.content().catch(() => "N/A");
        const status = response ? response.status() : "N/A";
        const headers = response ? response.headers() : {};
        
        console.log("--- Results ---");
        console.log(`Final URL:  ${finalUrl}`);
        console.log(`Status:     ${status}`);
        console.log(`Title:      ${pageTitle}`);
        console.log(`HTML length: ${html.length}`);
        
        const screenshotDir = path.join(process.cwd(), "screenshots");
        await fs.ensureDir(screenshotDir);
        
        // Save screenshot
        const screenshotPath = path.join(screenshotDir, "naukri_home_test.png");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(err => {
            console.error("Failed to capture screenshot:", err.message);
        });
        console.log(`Saved screenshot to: ${screenshotPath}`);
        
        // Save HTML
        const htmlPath = path.join(screenshotDir, "naukri_home_test.html");
        await fs.writeFile(htmlPath, html, "utf8");
        console.log(`Saved HTML to: ${htmlPath}`);
        
        // Log response headers
        console.log("Response Headers:", JSON.stringify(headers, null, 2));
        
    } catch (err) {
        console.error("Test encountered an unexpected error:", err.message);
    } finally {
        await browserInstance.close();
        console.log("Browser instance closed. Test complete.");
    }
})();
