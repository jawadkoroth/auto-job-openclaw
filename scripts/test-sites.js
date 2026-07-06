const { chromium } = require("playwright");

const sites = [
    "https://www.naukri.com",
    "https://www.linkedin.com",
    "https://www.foundit.in",
    "https://www.hirist.tech"
];

(async () => {

    const browser = await chromium.launch({
        headless: true
    });

    const page = await browser.newPage();

    for (const site of sites) {

        try {

            console.log("\n==================================");
            console.log(site);

            const response = await page.goto(site, {
                waitUntil: "domcontentloaded",
                timeout: 60000
            });

            console.log("Status :", response.status());
            console.log("Title  :", await page.title());

            const name = site
                .replace("https://", "")
                .replace("www.", "")
                .replace(/\./g, "_");

            await page.screenshot({
                path: `screenshots/${name}.png`,
                fullPage: true
            });

        } catch (err) {

            console.log("FAILED:", err.message);

        }

    }

    await browser.close();

})();
