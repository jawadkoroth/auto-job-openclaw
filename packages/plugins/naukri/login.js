/**
 * Naukri Login Automation script
 * @param {import("./index")} plugin 
 */
module.exports = async function login(plugin) {
    const { browserManager, logger, config } = plugin;
    logger.info("Naukri login flow initiated.", { plugin: "naukri", action: "login" });
    
    const page = await browserManager.newPage();
    const portalUrl = config.portals.naukri.url;
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    
    const loginButtonSelector = "#login_Layer";
    const loggedInSelector = "a[href*='naukri.com/mnj/profile'], .nICM-profile-header, a:has-text('View profile')"; 
    
    try {
        // Quick check if already logged in via persistent session
        await page.waitForSelector(`${loginButtonSelector}, ${loggedInSelector}`, { timeout: 10000 });
        if (await page.locator(loggedInSelector).count() > 0) {
            logger.info("Already logged in to Naukri via active session profile.", { plugin: "naukri", action: "login" });
            return true;
        }
    } catch (e) {
        logger.warn("Could not determine login state from selectors, continuing with standard login.", { plugin: "naukri", action: "login" });
    }
    
    const email = config.portals.naukri.email;
    const password = config.portals.naukri.password;
    if (!email || !password) {
        throw new Error("Naukri credentials are missing in configurations.");
    }
    
    logger.info("Clicking landing page login button...", { plugin: "naukri", action: "login" });
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
    const isLoggedIn = (await page.locator(loggedInSelector).count() > 0) || 
                       page.url().includes("mnj/profile") || 
                       page.url().includes("dashboard");
                       
    if (isLoggedIn) {
        logger.info("Naukri login completed successfully.", { plugin: "naukri", action: "login", success: true });
        return true;
    } else {
        logger.error("Naukri login verification failed. Screenshot saved.", { plugin: "naukri", action: "login", success: false });
        await browserManager.takeScreenshot(page, "naukri_login_failed");
        return false;
    }
};
