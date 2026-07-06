const { newPage, closeBrowser } = require("../playwright/core/browser");

(async () => {

    const page = await newPage();

    await page.goto("https://example.com");

    console.log(await page.title());

    await page.screenshot({
        path: "logs/example.png",
        fullPage: true
    });

    await closeBrowser();

})();
