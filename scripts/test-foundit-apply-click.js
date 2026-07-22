const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const bi = new BrowserInstance("foundit");
    await bi.launch();
    const page = await bi.newPage();
    await page.goto("https://www.foundit.in/srp/results?query=DevOps%20Engineer&locations=Bangalore", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const cards = page.locator(".cardContainer");
    const count = await cards.count();
    console.log(`Found ${count} cards.`);

    for (let i = 0; i < Math.min(count, 5); i++) {
        const card = cards.nth(i);
        const titleLoc = card.locator(".jobTitle, .title, a, h2, h3").first();
        const titleText = await titleLoc.textContent();
        console.log(`\n========================================`);
        console.log(`CARD ${i}: "${titleText.trim()}"`);

        await card.click().catch(() => {});
        await page.waitForTimeout(2000);

        const applyBtn = page.locator("button:has-text('Apply Now'), a:has-text('Apply Now'), div:has-text('Apply Now')").last();
        if (await applyBtn.count() > 0 && await applyBtn.isVisible().catch(() => false)) {
            console.log("Found 'Apply Now' button. Clicking...");
            
            const [popup] = await Promise.all([
                page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null),
                applyBtn.click({ force: true }).catch(() => {})
            ]);

            await page.waitForTimeout(3000);

            if (popup) {
                console.log(`🎉 POPUP OPENED! URL: ${popup.url()}`);
                await popup.close().catch(() => {});
            } else {
                console.log(`Page URL after click: ${page.url()}`);
            }
        } else {
            console.log("No visible 'Apply Now' button.");
        }
    }

    await bi.close();
})();
