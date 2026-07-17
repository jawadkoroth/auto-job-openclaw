const telegramService = require("../../../apps/telegram");

module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Instahyre login routine started.");

    try {
        logger.info("Verifying active login state on Instahyre...");
        try {
            await page.goto("https://www.instahyre.com/candidate/opportunities/", { waitUntil: "domcontentloaded", timeout: 20000 });
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(2000);
            if (await plugin.health(page)) {
                logger.info("Existing authenticated session detected on opportunities page.");
                return true;
            }
        } catch (e) {
            logger.warn(`Initial session check navigation failed: ${e.message}`);
        }

        const loginUrl = "https://www.instahyre.com/login/";
        logger.info(`Navigating to Instahyre login page: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);

        if (page.url().includes("/candidate/opportunities") || await plugin.health(page)) {
            logger.info("Redirected to candidate opportunities page. Already logged in!");
            return true;
        }

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            logger.info("HEADFUL_AUTH_SETUP is true. Please perform Instahyre login manually in the open browser window...");
            for (let i = 0; i < 150; i++) {
                await page.waitForTimeout(2000);
                if (await plugin.health(page)) {
                    logger.info("Manual Instahyre login detected successfully!");
                    return true;
                }
            }
            logger.error("Timed out waiting for manual Instahyre login.");
            return false;
        }

        const email = config.portals.instahyre.email;
        const password = config.portals.instahyre.password;
        if (!email || !password) {
            throw new Error("Missing Instahyre email/password in configurations.");
        }

        logger.info("Entering Instahyre credentials...");
        await page.waitForSelector("#email", { timeout: 10000 });
        
        await page.click("#email");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(email, { delay: 40 });

        await page.click("#password");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(password, { delay: 40 });

        logger.info("Submitting login form...");
        await page.click('button[type="submit"]');

        logger.info("Waiting for opportunities/dashboard redirect...");
        await page.waitForURL("**/candidate/opportunities**", { timeout: 20000 }).catch(() => {
            logger.warn("Did not detect redirect to opportunities page within timeout.");
        });

        await page.waitForTimeout(3000);
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
            const failDir = path.join(process.cwd(), "sessions", "instahyre");
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
