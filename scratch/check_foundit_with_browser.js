const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const portal = "foundit";
    console.log(`Starting ${portal} browser test...`);
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        const searchUrl = "https://www.foundit.in/srp/results?query=DevOps&locations=Bangalore";
        console.log(`Navigating to ${searchUrl}...`);
        const response = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForTimeout(5000);
        
        console.log(`HTTP Status: ${response.status()}`);
        console.log(`Page Title:  ${await page.title()}`);
        console.log(`Current URL: ${page.url()}`);
        
        const cardCount = await page.locator(".job-card, .srpCard, .card-body, [class*='jobCard']").count();
        console.log(`Cards found: ${cardCount}`);

        await page.screenshot({ path: "screenshots/foundit_search_browser.png", fullPage: true });
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
