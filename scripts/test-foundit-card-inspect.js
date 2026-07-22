const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const bi = new BrowserInstance("foundit");
    await bi.launch();
    const page = await bi.newPage();
    await page.goto("https://www.foundit.in/srp/results?query=DevOps%20Engineer&locations=Bangalore", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const titleLinks = page.locator(".jobTitle, .title, a[href*='job-detail']");
    const count = await titleLinks.count();
    console.log(`Found ${count} title links.`);

    for (let i = 0; i < Math.min(count, 5); i++) {
        const link = titleLinks.nth(i);
        const text = await link.textContent().catch(() => "");
        console.log(`\n========================================`);
        console.log(`LINK ${i}: "${text.trim()}"`);

        await link.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2500);

        const applyButtons = page.locator("button:has-text('Apply Now'), a:has-text('Apply Now')");
        const btnCount = await applyButtons.count();
        console.log(`Found ${btnCount} Apply Now buttons.`);

        if (btnCount > 0) {
            const targetBtn = applyButtons.first();
            console.log("Clicking Apply Now button...");

            const [popup] = await Promise.all([
                page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null),
                targetBtn.click({ force: true }).catch(() => {})
            ]);

            await page.waitForTimeout(3000);

            if (popup) {
                console.log(`🚀 POPUP DETECTED! External URL: ${popup.url()}`);
                await popup.close().catch(() => {});
            } else {
                console.log(`Current main page URL after click: ${page.url()}`);
            }
        }
    }

    await bi.close();
})();
