const telegramService = require("../../../apps/telegram");

module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Instahyre login routine started.");

    try {
        logger.info("Verifying active login state on Instahyre...");
        try {
            await page.goto("https://www.instahyre.com/candidate/opportunities/", { waitUntil: "domcontentloaded", timeout: 20000 });
            if (await plugin.health(page)) {
                logger.info("Existing authenticated session detected on opportunities page.");
                return true;
            }
        } catch (e) {
            logger.warn(`Initial session check navigation failed: ${e.message}`);
        }

        const loginUrl = "https://www.instahyre.com/login/";
        logger.info(`Navigating to Instahyre login page: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });

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
            return false;
        }
    } catch (err) {
        logger.error(`Login process failed: ${err.message}`);
        throw err;
    }
};
