const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({
        headless: true
    });

    const page = await browser.newPage();

    const response = await page.goto("https://www.naukri.com", {
        waitUntil: "domcontentloaded"
    });

    console.log("Status:", response.status());

    console.log("URL:", page.url());

    console.log("Title:", await page.title());

    console.log("HTML length:", (await page.content()).length);

    await page.screenshot({
        path: "screenshots/check.png",
        fullPage: true
    });

    await browser.close();
})();
