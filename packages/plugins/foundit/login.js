const fs = require("fs-extra");
const path = require("path");
const contextManager = require("../../browser/ContextManager");

/**
 * Multi-signal read-only Foundit authentication check.
 * NEVER calls page.goto(), reload(), or performs navigation.
 */
async function checkFounditAuth(page) {
    let positiveSignals = 0;
    let negativeSignals = 0;
    const details = [];

    try {
        const currentUrl = page.url();

        // 1. URL Signals
        if (currentUrl.includes("/seeker/dashboard") || currentUrl.includes("/seeker/profile") || currentUrl.includes("/seeker/my-applications")) {
            positiveSignals++;
            details.push("authenticated_url");
        }
        if (currentUrl.includes("/rio/login") || currentUrl.includes("/seeker/login")) {
            negativeSignals++;
            details.push("login_url");
        }

        // 2. DOM Signals: Logout option (strong positive)
        const logoutCount = await page.locator("a[href*='logout'], a[href*='/seeker/logout'], :has-text('Logout'), :has-text('Sign Out')").count().catch(() => 0);
        if (logoutCount > 0) {
            positiveSignals += 2;
            details.push("logout_button");
        }

        // 3. DOM Signals: User Profile & Account Menu Elements
        const profileCount = await page.locator("a[href*='/seeker/profile'], .profile-name, .userName, #userNameProfile, div.user-profile-info, div[class*='userProfile'], div[class*='profileCard']").count().catch(() => 0);
        if (profileCount > 0) {
            positiveSignals++;
            details.push("profile_indicator");
        }

        // 4. Cookie / Token Signals
        const cookies = await page.context().cookies().catch(() => []);
        const authCookieNames = ["seeker_id", "auth_token", "access_token", "loggedIn", "session_token", "JSESSIONID", "user_id"];
        const foundAuthCookie = cookies.some(c => authCookieNames.some(name => c.name.toLowerCase().includes(name.toLowerCase()) && c.value && c.value.length > 3));
        if (foundAuthCookie) {
            positiveSignals++;
            details.push("auth_cookie");
        }

        // 5. Negative DOM Signals (Active bare login form)
        const loginFormCount = await page.locator("button#loginSubmit, #signInBtn, input#userName, input#password").count().catch(() => 0);
        if (loginFormCount > 0 && logoutCount === 0) {
            negativeSignals++;
            details.push("login_form_visible");
        }

        const isAuthenticated = positiveSignals >= 2 || (positiveSignals >= 1 && logoutCount > 0);
        return {
            isAuthenticated,
            positiveSignals,
            negativeSignals,
            url: currentUrl,
            details
        };
    } catch (e) {
        return {
            isAuthenticated: false,
            positiveSignals: 0,
            negativeSignals: 1,
            url: page.url(),
            details: [e.message]
        };
    }
}

/**
 * Network diagnostics listener for authentication requests
 */
function attachNetworkDiagnostics(page, logger) {
    const isFounditUrl = (url) => {
        try {
            const host = new URL(url).hostname;
            return host.includes("foundit.in") || host.includes("monsterindia.com");
        } catch (e) {
            return false;
        }
    };

    const redactUrl = (url) => {
        return url.replace(/(token|password|otp|auth|code|secret|credential)=[^&]+/gi, "$1=[REDACTED]");
    };

    page.on("requestfailed", (req) => {
        const url = req.url();
        if (isFounditUrl(url)) {
            logger.warn(`[foundit network] Request failed: ${req.method()} ${redactUrl(url)} - Reason: ${req.failure()?.errorText || "Unknown"}`);
        }
    });

    page.on("response", (res) => {
        const url = res.url();
        if (isFounditUrl(url)) {
            const status = res.status();
            if (status >= 400) {
                logger.warn(`[foundit network] HTTP ${status} error: ${res.request().method()} ${redactUrl(url)}`);
            } else if (status >= 300 && status < 400) {
                const loc = res.headers()["location"] || "";
                logger.info(`[foundit network] Redirect HTTP ${status}: ${redactUrl(url)} -> ${redactUrl(loc)}`);
            }
        }
    });
}

module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Foundit login routine started.");

    // Attach network diagnostics for authentication flow
    attachNetworkDiagnostics(page, logger);

    // =========================================================================
    // MANUAL AUTHENTICATION MODE (HEADFUL_AUTH_SETUP === "true")
    // =========================================================================
    if (process.env.HEADFUL_AUTH_SETUP === "true") {
        console.log("[foundit] Manual authentication mode started");
        logger.info("[foundit] Manual authentication mode started");

        const loginUrl = "https://www.foundit.in/rio/login/seeker";
        const currentUrl = page.url();

        // Navigate to login page ONCE if not already on Foundit
        if (!currentUrl.includes("foundit.in")) {
            logger.info(`Navigating to Foundit login page: ${loginUrl}`);
            await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
            await page.waitForTimeout(2000);
        }

        console.log("[foundit] Initial login navigation completed");
        console.log("[foundit] Browser control handed to user");
        logger.info("[foundit] Initial login navigation completed");
        logger.info("[foundit] Browser control handed to user");

        // Read-only polling loop for up to 5 minutes (100 iterations x 3000ms)
        const maxPolls = 100;
        let authConfirmed = false;

        for (let i = 0; i < maxPolls; i++) {
            await page.waitForTimeout(3000);

            const authState = await checkFounditAuth(page);
            console.log(`[foundit] Auth poll: URL=${authState.url}, positiveSignals=${authState.positiveSignals}, negativeSignals=${authState.negativeSignals}`);
            logger.info(`[foundit] Auth poll: URL=${authState.url}, positiveSignals=${authState.positiveSignals}, negativeSignals=${authState.negativeSignals}`);

            if (authState.isAuthenticated) {
                authConfirmed = true;
                console.log("[foundit] Authentication confirmed");
                console.log("[foundit] Waiting for session stabilization");
                logger.info("[foundit] Authentication confirmed");
                logger.info("[foundit] Waiting for session stabilization");

                // Wait 4 seconds for session state to settle
                await page.waitForTimeout(4000);

                // Export storageState.json
                const sessionPath = contextManager.getContextPath("foundit");
                await fs.ensureDir(sessionPath);
                const storageStatePath = path.join(sessionPath, "storageState.json");

                const state = await page.context().storageState();
                await fs.writeJson(storageStatePath, state, { spaces: 2 });

                const cookiesCount = state.cookies ? state.cookies.length : 0;
                const originsCount = state.origins ? state.origins.length : 0;

                console.log("[foundit] storageState exported");
                console.log(`[foundit] Cookies exported: ${cookiesCount}`);
                console.log(`[foundit] Origins exported: ${originsCount}`);
                logger.info("[foundit] storageState exported");
                logger.info(`[foundit] Cookies exported: ${cookiesCount}`);
                logger.info(`[foundit] Origins exported: ${originsCount}`);

                await contextManager.updateMetadata("foundit", { sessionHealth: "healthy" }).catch(() => {});
                return true;
            }
        }

        logger.error("[foundit] Timed out waiting for manual Foundit login after 5 minutes.");
        const failDir = path.join(process.cwd(), "sessions", "foundit");
        await fs.ensureDir(failDir);
        await page.screenshot({ path: path.join(failDir, "login_failure.png") }).catch(() => {});
        const html = await page.content().catch(() => "");
        await fs.writeFile(path.join(failDir, "login_failure.html"), html).catch(() => {});
        return false;
    }

    // =========================================================================
    // PRODUCTION / HEADLESS AUTHENTICATION FLOW
    // =========================================================================
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
            await contextManager.updateMetadata("foundit", { sessionHealth: "healthy" }).catch(() => {});
            
            try {
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
            await contextManager.updateMetadata("foundit", { sessionHealth: "failed" }).catch(() => {});
            throw new Error("Authentication failed. Session health check returned false.");
        }
    } catch (err) {
        logger.error(`Login process failed: ${err.message}`);
        try {
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

module.exports.checkFounditAuth = checkFounditAuth;
