/**
 * Naukri Login Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 */
module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Naukri login flow initiated.");
    
    const portalUrl = config.portals.naukri.url;
    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    
    const loginButtonSelector = "#login_Layer";
    
    if (await plugin.health(page)) {
        logger.info("Already logged in to Naukri via active session profile.");
        return true;
    }
    
    const email = config.portals.naukri.email;
    const password = config.portals.naukri.password;
    if (!email || !password) {
        throw new Error("Naukri credentials are missing in configurations.");
    }
    
    logger.info("Clicking landing page login button...");
    await page.click(loginButtonSelector);
    
    const usernameInput = "input[placeholder*='Username'], input[placeholder*='Email'], input[placeholder*='ID']";
    const passwordInput = "input[placeholder*='Password']";
    
    await page.waitForSelector(usernameInput, { timeout: 10000 });
    await page.fill(usernameInput, email);
    await page.fill(passwordInput, password);
    
    const submitBtn = "button[type='submit']";
    await page.click(submitBtn);
    
    // Wait for redirect to finish
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    
    // Verify successful login
    const isLoggedIn = await plugin.health(page);
    if (isLoggedIn) {
        logger.info("Naukri login completed successfully.");
        return true;
    } else {
        logger.error("Naukri login verification failed.");
        return false;
    }
};
