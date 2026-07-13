const BrowserInstance = require("../packages/browser/BrowserInstance");

(async () => {
    const portal = "weworkremotely";
    const browserInstance = new BrowserInstance(portal);
    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();
        
        const searchUrl = "https://weworkremotely.com/remote-jobs/search?term=DevOps";
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForTimeout(5000);
        
        const count = await page.locator("li.job, .jobs li, section.jobs article, li").count();
        console.log(`Potential job elements: ${count}`);
        
        const sampleStructure = await page.evaluate(() => {
            // Find sections/articles/list items
            const elements = Array.from(document.querySelectorAll("section.jobs li, article, .jobs li")).slice(0, 5);
            return elements.map(el => ({
                tagName: el.tagName,
                className: el.className,
                innerText: el.innerText ? el.innerText.trim().substring(0, 150) : "",
                html: el.outerHTML.substring(0, 300)
            }));
        });
        
        console.log("Sample Structures:", JSON.stringify(sampleStructure, null, 2));
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
