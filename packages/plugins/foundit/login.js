module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Foundit login routine started.");

    try {
        logger.info("Verifying active login state on Foundit...");
        try {
            await page.goto("https://www.foundit.in/", { waitUntil: "domcontentloaded", timeout: 20000 });
            if (await plugin.health(page)) {
                logger.info("Existing authenticated session detected on Foundit homepage.");
                return true;
            }
        } catch (e) {
            logger.warn(`Initial session check navigation failed: ${e.message}`);
        }

        const loginUrl = "https://www.foundit.in/login";
        logger.info(`Navigating to Foundit login page: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });

        const email = config.portals.foundit.email;
        const password = config.portals.foundit.password;
        if (!email || !password) {
            throw new Error("Missing Foundit email/password in configurations.");
        }

        logger.info("Entering Foundit credentials...");
        await page.waitForSelector("#signInName, input[name='username']", { timeout: 10000 });

        await page.click("#signInName, input[name='username']");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(email, { delay: 40 });

        await page.click("#password, input[name='password']");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(password, { delay: 40 });

        logger.info("Submitting login form...");
        await page.click("input[type='submit'], #signInBtn, button:has-text('Login'), button:has-text('Sign In')");

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
