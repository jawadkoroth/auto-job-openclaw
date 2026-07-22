const { chromium } = require("playwright");

async function inspectWwrDom() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const url = "https://weworkremotely.com/remote-jobs/proxify-ab-senior-devops-engineer-azure-6";
    console.log(`[Oracle DOM Test] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    const title = await page.title();
    console.log(`Page title: "${title}"`);

    const anchors = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a")).map(a => ({
            text: a.innerText.trim(),
            href: a.href
        })).slice(0, 30);
    });

    console.log("All page anchors:", JSON.stringify(anchors, null, 2));

    await browser.close();
}

inspectWwrDom().catch(console.error);
