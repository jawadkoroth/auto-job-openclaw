/**
 * Naukri Login Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 */
module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Naukri login routine started.");
    
    // 1. Detect existing session
    // Navigate to profile page - if authenticated, it loads profile directly. 
    // If not, it redirects to landing or login.
    logger.info("Verifying active login state...");
    try {
        await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
        if (await plugin.health(page)) {
            logger.info("Existing authenticated session detected on homepage.");
            return true;
        }
    } catch (e) {
        logger.warn(`Session check navigation failed: ${e.message}. Proceeding to login.`);
        await page.goto("about:blank").catch(() => {});
    }

    // 2. Direct to login page
    const loginUrl = "https://www.naukri.com/nlogin/login";
    logger.info(`Navigating to login page: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    const email = config.portals.naukri.email;
    const password = config.portals.naukri.password;
    if (!email || !password) {
        throw new Error("Missing Naukri email/password in configurations.");
    }
    
    // 3. Fill and submit credentials
    logger.info("Entering credentials via simulated human keystrokes...");
    await page.waitForSelector("#usernameField", { timeout: 10000 });
    
    // Type email
    await page.click("#usernameField");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    for (const char of email) {
        await page.keyboard.type(char);
        await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
    }
    
    // Type password
    await page.click("#passwordField");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    for (const char of password) {
        await page.keyboard.type(char);
        await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
    }
    
    logger.info("Submitting login form...");
    await page.click('button[type="submit"]');
    
    // Wait for redirect to profile page to complete naturally
    logger.info("Waiting for post-login redirection to complete...");
    await page.waitForURL("**/mnj/profile**", { timeout: 25000 }).catch(() => {
        logger.warn("Did not detect redirect to profile page within timeout.");
    });
    
    // Settle delay to let session cookies write to persistent context
    await page.waitForTimeout(5000);
    
    const isLoggedIn = await plugin.health(page);
    if (isLoggedIn) {
        logger.info("Authentication verification successful.");
        return true;
    } else {
        logger.error("Authentication failed. Session verification indicated offline.");
        return false;
    }
};
