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

        if (page.url().includes("/jobs") || await plugin.health(page)) {
            logger.info("Redirected to jobs page. Already logged in!");
            return true;
        }

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            logger.info("HEADFUL_AUTH_SETUP is true. Please perform Wellfound login manually in the open browser window...");
            for (let i = 0; i < 150; i++) {
                await page.waitForTimeout(2000);
                if (await plugin.health(page)) {
                    logger.info("Manual Wellfound login detected successfully!");
                    return true;
                }
            }
            logger.error("Timed out waiting for manual Wellfound login.");
            return false;
        }

        const email = config.portals.wellfound.email;
        const password = config.portals.wellfound.password;
        if (!email || !password) {
            throw new Error("Missing Wellfound email/password in configurations.");
        }

        logger.info("Entering Wellfound credentials...");
        const emailInput = page.locator("input[type='email'], input[name='email'], input#user_email, input#email").first();
        await emailInput.waitFor({ timeout: 15000 });
        await emailInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await emailInput.fill(email);

        const passwordInput = page.locator("input[type='password'], input[name='password'], input#user_password, input#password").first();
        await passwordInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await passwordInput.fill(password);

        logger.info("Submitting login form...");
        const submitBtn = page.locator("input[type='submit'], button[type='submit'], button:has-text('Log in'), button:has-text('Sign in')").first();
        await submitBtn.click();

        logger.info("Waiting for dashboard redirect...");
        await page.waitForTimeout(5000);

        const isLoggedIn = await plugin.health(page);
        if (isLoggedIn) {
            logger.info("Authentication verification successful.");
            return true;
        } else {
            logger.error("Authentication failed. Session health check returned false.");
            throw new Error("Authentication failed. Session health check returned false.");
        }
    } catch (err) {
        logger.error(`Login process failed: ${err.message}`);
        try {
            const fs = require("fs-extra");
            const path = require("path");
            const failDir = path.join(process.cwd(), "sessions", "wellfound");
            await fs.ensureDir(failDir);
            await page.screenshot({ path: path.join(failDir, "login_failure.png") }).catch(() => {});
            const html = await page.content().catch(() => "");
            await fs.writeFile(path.join(failDir, "login_failure.html"), html).catch(() => {});
            logger.info(`Saved diagnostic HTML + screenshot to ${failDir}`);
        } catch (e) {
            logger.warn(`Could not save login failure diagnostics: ${e.message}`);
        }
        throw err;
    }
};
