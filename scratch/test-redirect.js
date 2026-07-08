const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const response = await page.goto("https://www.google.com");
    const req = response.request();
    console.log("req exists:", !!req);
    console.log("req.redirectedFrom exists:", !!req.redirectedFrom);
    
    let redirectChain = [];
    let currentReq = req.redirectedFrom();
    while (currentReq) {
        redirectChain.unshift(currentReq.url());
        currentReq = currentReq.redirectedFrom();
    }
    console.log("Redirect Chain URL list:", redirectChain);
    
    await browser.close();
})();
