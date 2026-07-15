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

        const loginUrl = "https://www.foundit.in/rio/login/seeker";
        logger.info(`Navigating to Foundit login page: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);

        // Accept cookie consent if visible
        try {
            const acceptCookie = page.locator("button#acceptAll, button:has-text('Okay'), button:has-text('Accept All')").first();
            if (await acceptCookie.count() > 0 && await acceptCookie.isVisible()) {
                await acceptCookie.click();
                await page.waitForTimeout(1000);
            }
        } catch (e) {
            logger.debug(`Could not click cookie consent button: ${e.message}`);
        }

        const email = config.portals.foundit.email;
        const password = config.portals.foundit.password;
        if (!email || !password) {
            throw new Error("Missing Foundit email/password in configurations.");
        }

        logger.info("Entering Foundit credentials...");

        // Select login via password option if visible
        try {
            const pwdLoginOpt = page.locator("span:has-text('Login via Password'), :has-text('Login via Password')").first();
            if (await pwdLoginOpt.count() > 0 && await pwdLoginOpt.isVisible()) {
                await pwdLoginOpt.click();
                await page.waitForTimeout(1000);
            }
        } catch (e) {
            logger.debug(`Could not click Login via Password option: ${e.message}`);
        }

        const usernameInput = page.locator("input#userName, #signInName, input[name='username']").first();
        await usernameInput.waitFor({ timeout: 15000 });
        await usernameInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await usernameInput.fill(email);

        const passwordInput = page.locator("input#password, input[name='password']").first();
        await passwordInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await passwordInput.fill(password);

        logger.info("Submitting login form...");
        const submitBtn = page.locator("button#loginSubmit, input[type='submit'], #signInBtn, button:has-text('Login'), button:has-text('Sign In')").first();
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
