const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const portal = "foundit";
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        const testUrl = "https://www.foundit.in/job-detail/58763172";
        console.log(`Navigating to ${testUrl}...`);
        const response = await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForTimeout(5000);
        
        console.log(`Status: ${response.status()}`);
        console.log(`URL after redirect: ${page.url()}`);
        console.log(`Title: ${await page.title()}`);
        
        // Find if there is an apply button
        const applyText = await page.evaluate(() => {
            const btn = document.querySelector(".applyBtn, button:has-text('Apply'), .apply-button");
            return btn ? { text: btn.innerText, className: btn.className } : "Not found";
        });
        console.log("Apply button details:", applyText);
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
