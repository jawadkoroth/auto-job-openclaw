const { chromium } = require("playwright");

async function inspectWwrCta() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const sampleUrl = "https://weworkremotely.com/remote-jobs/brightorder-full-stack-developer-devops-cloud-systems";
    console.log(`Navigating to sample WWR job page: ${sampleUrl}`);
    await page.goto(sampleUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    console.log(`Page title: "${await page.title()}"`);
    const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a")).slice(0, 20).map(a => ({ text: a.innerText.trim(), href: a.href }));
    });
    console.log("Sample links on page:", allLinks);
    await browser.close();
}

inspectWwrCta().catch(console.error);
