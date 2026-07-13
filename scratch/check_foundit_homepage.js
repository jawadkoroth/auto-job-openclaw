const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log("Navigating to homepage...");
    await page.goto("https://www.foundit.in/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    
    console.log("URL:", page.url());
    console.log("Title:", await page.title());

    // Find input fields
    const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("input")).map(el => ({
            id: el.id,
            name: el.name,
            type: el.type,
            className: el.className,
            placeholder: el.placeholder
        }));
    });
    console.log("Inputs found on homepage:", JSON.stringify(inputs, null, 2));

    await page.screenshot({ path: "screenshots/foundit_home_check.png", fullPage: true });
    await browser.close();
})();
