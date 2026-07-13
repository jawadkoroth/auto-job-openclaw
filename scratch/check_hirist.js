const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    console.log("Navigating to homepage...");
    await page.goto("https://www.hirist.tech/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    
    console.log("Opening login modal...");
    const loginTrigger = page.locator("button:has-text('Login'), a:has-text('Login')").filter({ visible: true }).first();
    await loginTrigger.click();
    await page.waitForTimeout(3000);
    
    // Find all buttons inside the modal dialog
    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("button, input[type='submit']")).map(el => ({
            text: el.innerText.trim(),
            tagName: el.tagName,
            type: el.type,
            className: el.className
        }));
    });
    console.log("Buttons found in modal:", JSON.stringify(buttons, null, 2));

    await browser.close();
})();
