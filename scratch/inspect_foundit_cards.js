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
        
        const content = await page.evaluate(() => {
            const set = new Set();
            document.querySelectorAll("div, li").forEach(el => {
                if (el.className && (el.className.includes("card") || el.className.includes("Card") || el.className.includes("job") || el.className.includes("Job"))) {
                    set.add({
                        tagName: el.tagName,
                        className: el.className,
                        text: el.innerText ? el.innerText.trim().substring(0, 100) : ""
                    });
                }
            });
            return Array.from(set).slice(0, 40);
        });
        
        console.log("Card-like elements found:", JSON.stringify(content, null, 2));
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
