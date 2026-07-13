const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    const searchUrl = "https://www.hirist.tech/search/devops?loc=bangalore";
    console.log("Navigating to:", searchUrl);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    
    // Inspect the first job card details
    const cardDetails = await page.evaluate(() => {
        const card = document.querySelector(".joblist-card-v2");
        if (!card) return "Card not found";
        
        const anchors = Array.from(card.querySelectorAll("a")).map(a => ({
            text: a.innerText,
            href: a.href,
            className: a.className
        }));
        
        const divs = Array.from(card.querySelectorAll("div")).map(d => ({
            text: d.innerText,
            className: d.className
        }));

        return {
            cardClass: card.className,
            cardText: card.innerText,
            anchors,
            divs
        };
    });
    
    console.log("Card details:", JSON.stringify(cardDetails, null, 2));
    await browser.close();
})();
