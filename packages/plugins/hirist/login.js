module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Hirist login routine started.");

    try {
        logger.info("Navigating to Hirist homepage...");
        await page.goto("https://www.hirist.tech/", { waitUntil: "domcontentloaded", timeout: 30000 });
        
        if (await plugin.health(page)) {
            logger.info("Existing authenticated session detected on Hirist homepage.");
            return true;
        }

        logger.info("Opening login modal on homepage...");
        const loginTrigger = page.locator("button:has-text('Login'), a:has-text('Login')").filter({ visible: true }).first();
        await loginTrigger.click();
        await page.waitForTimeout(2000);

        const email = config.portals.hirist.email;
        const password = config.portals.hirist.password;
        if (!email || !password) {
            throw new Error("Missing Hirist email/password in configurations.");
        }

        logger.info("Entering Hirist credentials...");
        await page.waitForSelector("input[name='email'], #email", { timeout: 10000 });

        await page.click("input[name='email'], #email");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(email, { delay: 40 });

        await page.click("input[name='password'], #password");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(password, { delay: 40 });

        logger.info("Submitting login form...");
        const submitBtn = page.locator("button[type='submit']").filter({ visible: true }).first();
        await submitBtn.click();

        logger.info("Waiting for dashboard redirect...");
        await page.waitForTimeout(5000);

        const isLoggedIn = await plugin.health(page);
        if (isLoggedIn) {
            logger.info("Authentication verification successful.");
            return true;
        } else {
            logger.error("Authentication failed. Session health check returned false.");
            return false;
        }
    } catch (err) {
        logger.error(`Login process failed: ${err.message}`);
        throw err;
    }
};
