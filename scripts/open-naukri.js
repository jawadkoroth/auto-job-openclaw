const { launchBrowser, closeBrowser } = require("../playwright/core/browser");
const logger = require("../playwright/core/logger");

(async () => {
    let context;

    try {
        context = await launchBrowser(true);

        const page = context.pages()[0] || await context.newPage();

        logger.info("Opening Naukri...");

        await page.goto("https://www.naukri.com", {
            waitUntil: "networkidle",
            timeout: 60000
        });

        console.log("Current Title:", await page.title());

        await page.screenshot({
            path: "./screenshots/naukri-home.png",
            fullPage: true
        });

        console.log("✅ Screenshot saved.");

    } catch (err) {

        console.error(err);

    } finally {

        if (context)
            await closeBrowser(context);

    }
})();
