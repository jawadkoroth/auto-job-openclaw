/**
 * Cutshort Login Module
 */
module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Initiating Cutshort login check / process...");

    try {
        const isHealthy = await plugin.health(page);
        if (isHealthy) {
            logger.info("Cutshort active session is valid.");
            return true;
        }

        const email = process.env.CUTSHORT_EMAIL || config.credentials?.cutshort?.email;
        const password = process.env.CUTSHORT_PASSWORD || config.credentials?.cutshort?.password;

        if (!email || !password) {
            logger.warn("Cutshort credentials missing in process.env or config.");
            return false;
        }

        logger.info("Navigating to Cutshort login / auth...");
        await page.goto("https://cutshort.io/jobs", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);

        // Click Login / Sign In modal trigger if present
        const loginBtn = page.locator("a:has-text('Login'), button:has-text('Login'), a:has-text('Sign In'), button:has-text('Sign In')").first();
        if (await loginBtn.isVisible().catch(() => false)) {
            await loginBtn.click().catch(() => {});
            await page.waitForTimeout(2000);
        }

        const emailInput = page.locator("input[type='email'], input[name='email'], input[placeholder*='email' i]").first();
        if (await emailInput.isVisible().catch(() => false)) {
            await emailInput.fill(email);
            const nextOrPass = page.locator("button:has-text('Next'), button:has-text('Continue'), input[type='password']").first();
            if (await nextOrPass.isVisible().catch(() => false)) {
                if ((await nextOrPass.getAttribute("type")) !== "password") {
                    await nextOrPass.click().catch(() => {});
                    await page.waitForTimeout(1500);
                }
            }
            const passInput = page.locator("input[type='password']").first();
            if (await passInput.isVisible().catch(() => false)) {
                await passInput.fill(password);
                const submitBtn = page.locator("button[type='submit'], button:has-text('Login'), button:has-text('Sign In')").first();
                await submitBtn.click().catch(() => {});
                await page.waitForTimeout(4000);
            }
        }

        const authenticated = await plugin.health(page);
        if (authenticated) {
            logger.info("Cutshort authentication succeeded.");
            return true;
        } else {
            logger.warn("Cutshort authentication completed but health check failed (OTP/2FA or CAPTCHA may be required).");
            return false;
        }
    } catch (err) {
        logger.error(`Error during Cutshort login: ${err.message}`);
        return false;
    }
};
