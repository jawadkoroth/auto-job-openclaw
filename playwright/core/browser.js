const { chromium } = require("playwright");
const path = require("path");

let browserContext = null;

async function launchBrowser() {
    if (browserContext) return browserContext;

    browserContext = await chromium.launchPersistentContext(
        path.join(process.cwd(), "sessions"),
        {
            headless: true,
            viewport: {
                width: 1440,
                height: 900
            },

            args: [
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox"
            ]
        }
    );

    return browserContext;
}

async function newPage() {
    const context = await launchBrowser();

    if (context.pages().length)
        return context.pages()[0];

    return await context.newPage();
}

async function closeBrowser() {
    if (browserContext) {
        await browserContext.close();
        browserContext = null;
    }
}

module.exports = {
    launchBrowser,
    newPage,
    closeBrowser
};
