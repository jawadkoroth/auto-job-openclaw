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
        
        const list = await page.evaluate(() => {
            const results = [];
            // Look for links that point to /remote-jobs/
            document.querySelectorAll("a").forEach(a => {
                if (a.href && a.href.includes("/remote-jobs/") && !a.href.includes("/search") && !a.href.includes("/categories")) {
                    // Go up to find parent container
                    let parent = a.parentElement;
                    let company = "";
                    let title = a.innerText;
                    
                    // Look for company class in siblings/parent
                    if (parent) {
                        const compEl = parent.querySelector(".company, .companyName");
                        if (compEl) company = compEl.innerText;
                    }
                    
                    results.push({
                        href: a.href,
                        text: a.innerText,
                        parentTagName: parent ? parent.tagName : "",
                        parentClass: parent ? parent.className : "",
                        company: company
                    });
                }
            });
            return results;
        });
        
        console.log("Found links pointing to jobs:", JSON.stringify(list.slice(0, 30), null, 2));
    } catch (e) {
        console.error("FAILED:", e.message);
    } finally {
        await browserInstance.close();
    }
})();
