const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    const searchUrl = "https://www.foundit.in/srp/results?query=DevOps&locations=Bangalore";
    console.log("Navigating to:", searchUrl);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000);
    
    console.log("URL:", page.url());
    console.log("Title:", await page.title());

    // Print all div classes
    const classes = await page.evaluate(() => {
        const set = new Set();
        document.querySelectorAll("div").forEach(el => {
            if (el.className) {
                set.add(el.className.split(" ")[0]);
            }
        });
        return Array.from(set).slice(0, 50);
    });
    console.log("Div classes found:", JSON.stringify(classes, null, 2));

    await page.screenshot({ path: "screenshots/foundit_search_check.png", fullPage: true });
    await browser.close();
})();
