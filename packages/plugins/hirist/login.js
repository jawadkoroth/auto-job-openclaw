module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Hirist login routine started.");

    try {
        logger.info("Navigating to Hirist homepage...");
        await page.goto("https://www.hirist.tech/", { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(5000);
        
        const exportStorageState = async () => {
            try {
                const fs = require("fs-extra");
                const path = require("path");
                const sessionDir = path.join(process.cwd(), "sessions", "hirist");
                await fs.ensureDir(sessionDir);
                const storageStatePath = path.join(sessionDir, "storageState.json");
                
                await page.context().storageState({ path: storageStatePath });
                
                const state = fs.readJsonSync(storageStatePath);
                const cookiesCount = state.cookies ? state.cookies.length : 0;
                const originsCount = state.origins ? state.origins.length : 0;
                
                logger.info(`[hirist] Portable authentication state exported successfully.`);
                logger.info(`[hirist] Storage state path: sessions/hirist/storageState.json`);
                logger.info(`[hirist] Cookie count: ${cookiesCount}`);
                logger.info(`[hirist] Origin count: ${originsCount}`);
            } catch (err) {
                logger.warn(`Failed to export storage state: ${err.message}`);
            }
        };

        if (await plugin.health(page)) {
            logger.info("Existing authenticated session detected.");
            await exportStorageState();
            return true;
        }

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            logger.info("HEADFUL_AUTH_SETUP is true. Please perform Hirist login manually in the open browser window...");
            for (let i = 0; i < 1200; i++) {
                await page.waitForTimeout(500);
                if (await page.isClosed()) {
                    logger.info("Browser window closed by user.");
                    break;
                }
                if (await plugin.health(page)) {
                    logger.info("Manual Hirist login detected successfully!");
                    logger.info("Navigating to jobfeed page to re-verify authentication...");
                    await page.goto("https://www.hirist.tech/jobfeed", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
                    await page.waitForTimeout(3000);
                    
                    if (await plugin.health(page)) {
                        logger.info("Re-verification on jobfeed page successful.");
                        await exportStorageState();
                        return true;
                    } else {
                        logger.warn("Re-verification after navigation to jobfeed failed. Continuing authentication poll.");
                    }
                }
            }
            logger.error("Timed out waiting for manual Hirist login.");
            throw new Error("LOGIN_TIMEOUT");
        }

        logger.info("No active session. Preparing to trigger login dropdown...");

        // Accept cookie consent if visible
        try {
            const gotItCookieBtn = page.locator("button:has-text('Got it')").first();
            if (await gotItCookieBtn.count() > 0 && await gotItCookieBtn.isVisible()) {
                await gotItCookieBtn.click();
                await page.waitForTimeout(1000);
            }
        } catch (e) {
            logger.debug(`Could not click cookie consent on Hirist: ${e.message}`);
        }

        logger.info("Opening login dropdown on homepage...");
        const loginTrigger = page.locator("button:has-text('Login'), div.login-btn, p.login, a:has-text('Login')").filter({ visible: true }).first();
        try {
            await loginTrigger.waitFor({ state: "visible", timeout: 25000 });
        } catch (e) {
            logger.info("Login trigger not visible. Checking if login form is already present.");
        }

        let isEmailVisible = await page.locator("input#login-email-input, input[name='email'], #email, input[placeholder='Enter your registered email id']").first().isVisible().catch(() => false);
        if (!isEmailVisible) {
            logger.info("Login form not visible. Clicking login trigger dropdown...");
            if (await loginTrigger.count() > 0) {
                await loginTrigger.click({ force: true }).catch(() => {});
                await page.waitForTimeout(2000);
                
                // Now click 'Jobseekers' submenu item to open candidate login form
                logger.info("Selecting Jobseekers option from dropdown...");
                const jobseekersOption = page.locator("a:has-text('Jobseekers'), p:has-text('Jobseekers'), span:has-text('Jobseekers'), div:has-text('Jobseekers')").filter({ visible: true }).last();
                await jobseekersOption.waitFor({ state: "visible", timeout: 8000 });
                await jobseekersOption.click({ force: true });
                await page.waitForTimeout(3000);
            }
        }

        const email = config.portals.hirist.email;
        const password = config.portals.hirist.password;
        if (!email || !password) {
            throw new Error("Missing Hirist email/password in configurations.");
        }

        // Detect and switch to Sign In state if needed
        const isSignInVisible = await page.locator("button#loginSubmit, input#login-email-input, input[placeholder='Enter your registered email id']").first().isVisible().catch(() => false);
        if (!isSignInVisible) {
            logger.info("Sign In form not visible. Checking for Sign In switcher...");
            const signInSwitch = page.locator("div.switch-container, span:has-text('Sign In'), a:has-text('Sign In')").filter({ visible: true }).last();
            if (await signInSwitch.count() > 0) {
                logger.info("Clicking Sign In switch...");
                await signInSwitch.click({ force: true });
                await page.waitForTimeout(2000);
            }
        }

        logger.info("Entering Hirist credentials...");
        const emailInput = page.locator("input#login-email-input, input[name='email'], #email, input[placeholder='Enter your registered email id']").first();
        await emailInput.waitFor({ state: "visible", timeout: 20000 });
        await emailInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await emailInput.fill(email);

        const passwordInput = page.locator("input#loginPassword, input[name='password'], #password, input[placeholder='Enter your password']").first();
        await passwordInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await passwordInput.fill(password);

        logger.info("Submitting login form...");
        const submitBtn = page.locator("button#loginSubmit, button:has-text('Login'), button[type='submit']").filter({ visible: true }).first();
        await submitBtn.click();

        logger.info("Waiting for dashboard redirect...");
        await page.waitForTimeout(5000);

        const isLoggedIn = await plugin.health(page);
        if (isLoggedIn) {
            logger.info("Authentication verification successful.");
            await exportStorageState();
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
            const failDir = path.join(process.cwd(), "sessions", "hirist");
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
