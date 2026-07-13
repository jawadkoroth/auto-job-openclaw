module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Wellfound login routine started.");

    try {
        logger.info("Verifying active login state on Wellfound...");
        try {
            await page.goto("https://wellfound.com/jobs", { waitUntil: "domcontentloaded", timeout: 20000 });
            if (await plugin.health(page)) {
                logger.info("Existing authenticated session detected on Wellfound.");
                return true;
            }
        } catch (e) {
            logger.warn(`Initial session check navigation failed: ${e.message}`);
        }

        const loginUrl = "https://wellfound.com/login";
        logger.info(`Navigating to Wellfound login page: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(3000);

        const email = config.portals.wellfound.email;
        const password = config.portals.wellfound.password;
        if (!email || !password) {
            throw new Error("Missing Wellfound email/password in configurations.");
        }

        logger.info("Entering Wellfound credentials...");
        await page.waitForSelector("#user_email, input[name='email']", { timeout: 10000 });

        await page.click("#user_email, input[name='email']");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(email, { delay: 40 });

        await page.click("#user_password, input[name='password']");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(password, { delay: 40 });

        logger.info("Submitting login form...");
        await page.click("input[type='submit'], button[type='submit'], button:has-text('Log in')");

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
