const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("https://cutshort.io/job/Senior-Software-Architect-Bengaluru-Bangalore-NeoGenCode-Technologies-Pvt-Ltd-EMFogiZR", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(3000);
    const title = await page.title();
    const content = await page.innerText("body");
    console.log("Title:", title);
    console.log("Snippet:", content.slice(0, 300));
    await browser.close();
})();
