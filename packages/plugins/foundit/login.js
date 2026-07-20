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

        if (page.url().includes("/seeker/dashboard") || await plugin.health(page)) {
            logger.info("Redirected to seeker dashboard. Already logged in!");
            return true;
        }

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            logger.info("HEADFUL_AUTH_SETUP is true. Please perform Foundit login manually in the open browser window...");
            for (let i = 0; i < 150; i++) {
                await page.waitForTimeout(2000);
                if (await plugin.health(page)) {
                    logger.info("Manual Foundit login detected successfully!");
                    return true;
                }
            }
            logger.error("Timed out waiting for manual Foundit login.");
            return false;
        }

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

        // Select login via password option
        logger.info("Opening login form via Password...");
        const pwdLoginOpt = page.locator("span:has-text('Login via Password')").first();
        try {
            await pwdLoginOpt.waitFor({ state: "visible", timeout: 8000 });
            await pwdLoginOpt.click({ force: true });
            await page.waitForTimeout(1500);
        } catch (e) {
            logger.info("Login via Password option not visible or click failed. Checking username input visibility.");
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
            const contextManager = require("../../browser/ContextManager");
            await contextManager.updateMetadata("foundit", { sessionHealth: "healthy" }).catch(() => {});
            
            // Export storageState.json
            try {
                const fs = require("fs-extra");
                const path = require("path");
                const sessionPath = contextManager.getContextPath("foundit");
                await fs.ensureDir(sessionPath);
                const storageStatePath = path.join(sessionPath, "storageState.json");
                await page.context().storageState({ path: storageStatePath });
                logger.info(`Saved storageState.json for foundit at ${storageStatePath}`);
            } catch (err) {
                logger.warn(`Failed saving storageState.json for foundit: ${err.message}`);
            }
            return true;
        } else {
            logger.error("Authentication failed. Session health check returned false.");
            const contextManager = require("../../browser/ContextManager");
            await contextManager.updateMetadata("foundit", { sessionHealth: "failed" }).catch(() => {});
            throw new Error("Authentication failed. Session health check returned false.");
        }
    } catch (err) {
        logger.error(`Login process failed: ${err.message}`);
        try {
            const fs = require("fs-extra");
            const path = require("path");
            const failDir = path.join(process.cwd(), "sessions", "foundit");
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
