const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const portal = "foundit";
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        const searchUrl = "https://www.foundit.in/srp/results?query=DevOps&locations=Bangalore";
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForTimeout(6000);
        
        console.log("URL before click:", page.url());
        
        console.log("Clicking the first cardContainer...");
        await page.click(".cardContainer");
        await page.waitForTimeout(3000);
        
        console.log("URL after click:", page.url());
        
        // Let's print the entire outer HTML of the card container to find if it has any custom attributes
        const outerHtml = await page.evaluate(() => {
            const card = document.querySelector(".cardContainer");
            if (!card) return "Card not found";
            return {
                attributes: Array.from(card.attributes).map(attr => `${attr.name}="${attr.value}"`),
                id: card.id,
                className: card.className
            };
        });
        console.log("Card attributes:", outerHtml);
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
