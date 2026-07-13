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
        
        const cardDetails = await page.evaluate(() => {
            const card = document.querySelector(".cardContainer");
            if (!card) return "Card not found";
            
            const html = card.innerHTML;
            const innerText = card.innerText;
            
            const anchors = Array.from(card.querySelectorAll("a")).map(a => ({
                text: a.innerText,
                href: a.href,
                className: a.className
            }));
            
            return {
                innerText,
                anchors,
                html
            };
        });
        
        console.log("Single Card Details:", JSON.stringify(cardDetails, null, 2));
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
