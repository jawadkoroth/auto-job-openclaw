const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");

(async () => {
    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    const browser = await chromium.launch({ headless: true });
    const contextOptions = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (fs.existsSync(storageStatePath)) contextOptions.storageState = storageStatePath;

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const rolesToTest = ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "AWS", "Kubernetes"];

    for (const r of rolesToTest) {
        console.log(`\nSearching Cutshort for: "${r}"...`);
        await page.goto(`https://cutshort.io/jobs?keyword=${encodeURIComponent(r)}`, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(3000);

        const links = page.locator("a[href*='/job/']");
        const count = await links.count();
        console.log(`Found ${count} job links.`);

        for (let i = 0; i < Math.min(count, 5); i++) {
            const href = await links.nth(i).getAttribute("href");
            const text = await links.nth(i).innerText();
            console.log(`  [${i + 1}] ${href}`);
            console.log(`      Text: "${text.replace(/\n/g, " | ")}"`);
        }
    }

    await browser.close();
})();
