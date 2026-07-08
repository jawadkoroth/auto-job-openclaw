const telegramService = require("../../../apps/telegram");
const fs = require("fs-extra");
const path = require("path");

async function runDiagnostics(requestedUrl, page, response, error, logger, isLandingPage = false) {
    let status = null;
    let headers = {};
    let finalUrl = page.url();
    let pageTitle = "N/A";
    let htmlContent = "";
    let redirectChain = [];
    
    if (response) {
        status = response.status();
        headers = response.headers();
        try {
            const request = response.request();
            if (request) {
                let currentReq = request.redirectedFrom();
                while (currentReq) {
                    redirectChain.unshift(currentReq.url());
                    currentReq = currentReq.redirectedFrom();
                }
            }
        } catch (e) {}
    }
    
    try {
        pageTitle = await page.title();
    } catch (e) {}
    
    try {
        htmlContent = await page.content();
    } catch (e) {}
    
    const snippetLength = isLandingPage ? 1000 : 500;
    const firstSnippet = htmlContent.substring(0, snippetLength);
    
    // Distinguish scenarios
    let isTimeout = false;
    let isNetworkError = false;
    let isAccessDenied = false;
    let isCaptcha = false;
    let isLoginPage = false;
    
    if (error) {
        if (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout")) {
            isTimeout = true;
        } else {
            isNetworkError = true;
        }
    }
    
    const lowerTitle = pageTitle.toLowerCase();
    const lowerHtml = htmlContent.toLowerCase();
    
    if (status === 403 || 
        lowerTitle.includes("access denied") || 
        lowerHtml.includes("access denied") || 
        lowerHtml.includes("you don't have permission to access")) {
        isAccessDenied = true;
    } else if (lowerHtml.includes("captcha") || 
               lowerHtml.includes("recaptcha") || 
               lowerHtml.includes("challenge-platform") || 
               lowerHtml.includes("robot") || 
               lowerTitle.includes("captcha") || 
               lowerTitle.includes("challenge")) {
        isCaptcha = true;
    } else if (lowerHtml.includes("usernamefield") || 
               lowerHtml.includes("passwordfield") || 
               (await page.$("#usernameField") !== null)) {
        isLoginPage = true;
    }
    
    // Extract browser fingerprint details
    let fingerprint = {
        userAgent: "N/A",
        webdriver: "N/A",
        vendor: "N/A",
        platform: "N/A",
        languages: [],
        pluginsLength: 0,
        hardwareConcurrency: "N/A",
        deviceMemory: "N/A",
        maxTouchPoints: "N/A",
        windowChromeExists: false,
        notificationPermission: "N/A",
        timezone: "N/A",
        locale: "N/A",
        viewport: {},
        screen: {}
    };

    try {
        fingerprint = await page.evaluate(async () => {
            let notificationPermission = "N/A";
            try {
                const permission = await navigator.permissions.query({ name: "notifications" });
                notificationPermission = permission.state;
            } catch (e) {
                notificationPermission = "Error: " + e.message;
            }
            
            let timezone = "N/A";
            let locale = "N/A";
            try {
                timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                locale = Intl.DateTimeFormat().resolvedOptions().locale || navigator.language;
            } catch (e) {}

            return {
                userAgent: navigator.userAgent,
                webdriver: navigator.webdriver,
                vendor: navigator.vendor,
                platform: navigator.platform,
                languages: navigator.languages || [],
                pluginsLength: navigator.plugins ? navigator.plugins.length : 0,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory || "N/A",
                maxTouchPoints: navigator.maxTouchPoints,
                windowChromeExists: !!window.chrome,
                notificationPermission: notificationPermission,
                timezone: timezone,
                locale: locale,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                screen: { width: window.screen.width, height: window.screen.height }
            };
        });
    } catch (evalErr) {
        logger.warn(`Failed to evaluate browser fingerprint: ${evalErr.message}`);
    }
    
    // JS Challenge Detection
    const challengeSignatures = [
        "akamai", "bm_sv", "_abck", "sensor", "challenge", "bot manager", "recaptcha", "cf_clearance", "captcha"
    ];
    const detectedChallenges = [];
    const headersStr = JSON.stringify(headers).toLowerCase();
    for (const sig of challengeSignatures) {
        if (lowerHtml.includes(sig) || lowerTitle.includes(sig) || headersStr.includes(sig)) {
            detectedChallenges.push(sig);
        }
    }

    logger.info(`--- NAUKRI DIAGNOSTIC RECORD ---`);
    logger.info(`Requested URL: ${requestedUrl}`);
    logger.info(`Final URL: ${finalUrl}`);
    logger.info(`Redirect Chain: ${JSON.stringify(redirectChain)}`);
    logger.info(`HTTP Status: ${status}`);
    logger.info(`Response Headers: ${JSON.stringify(headers, null, 2)}`);
    logger.info(`Page Title: ${pageTitle}`);
    logger.info(`navigator.userAgent: ${fingerprint.userAgent}`);
    logger.info(`navigator.webdriver: ${fingerprint.webdriver}`);
    logger.info(`navigator.vendor: ${fingerprint.vendor}`);
    logger.info(`navigator.platform: ${fingerprint.platform}`);
    logger.info(`navigator.languages: ${JSON.stringify(fingerprint.languages)}`);
    logger.info(`navigator.plugins.length: ${fingerprint.pluginsLength}`);
    logger.info(`navigator.hardwareConcurrency: ${fingerprint.hardwareConcurrency}`);
    logger.info(`navigator.deviceMemory: ${fingerprint.deviceMemory}`);
    logger.info(`navigator.maxTouchPoints: ${fingerprint.maxTouchPoints}`);
    logger.info(`window.chrome exists: ${fingerprint.windowChromeExists}`);
    logger.info(`navigator.permissions.query({name:"notifications"}): ${fingerprint.notificationPermission}`);
    logger.info(`timezone: ${fingerprint.timezone}`);
    logger.info(`locale: ${fingerprint.locale}`);
    logger.info(`viewport: ${JSON.stringify(fingerprint.viewport)}`);
    logger.info(`screen size: ${JSON.stringify(fingerprint.screen)}`);
    logger.info(`document.location.href: ${fingerprint.userAgent === "N/A" ? "N/A" : finalUrl}`);
    logger.info(`HTML snippet (first ${snippetLength} chars):\n${firstSnippet}`);
    
    if (detectedChallenges.length > 0) {
        logger.info(`[Challenge Detected] Found JS challenge signatures: ${JSON.stringify(detectedChallenges)}`);
    } else {
        logger.info(`[Challenge Detected] No known challenge signatures found.`);
    }
    logger.info(`--------------------------------`);
    
    let classification = "Unknown State";
    if (isAccessDenied) {
        classification = "Access Denied page";
    } else if (isCaptcha) {
        classification = "CAPTCHA challenge";
    } else if (isLoginPage) {
        classification = "Login page";
    } else if (isTimeout) {
        classification = "Timeout";
    } else if (isNetworkError) {
        classification = "Network error";
    }
    
    logger.info(`[Diagnostic] Classification: ${classification}`);
    
    // Save Landing Page HTML
    if (isLandingPage) {
        const screenshotDir = path.join(process.cwd(), "screenshots");
        fs.ensureDirSync(screenshotDir);
        const landingPath = path.join(screenshotDir, "landing.html");
        try {
            await fs.writeFile(landingPath, htmlContent, "utf8");
            logger.info(`Saved landing page HTML to: ${landingPath}`);
        } catch (saveErr) {
            logger.error(`Failed to save landing page HTML: ${saveErr.message}`);
        }
    }

    // Save Access Denied diagnostics
    if (isAccessDenied) {
        const timestamp = Date.now();
        const diagDir = path.join(process.cwd(), "screenshots", `diagnostics_${timestamp}`);
        await fs.ensureDirSync(diagDir);
        
        try {
            await fs.writeFile(path.join(diagDir, "access_denied.html"), htmlContent, "utf8");
            await page.screenshot({ path: path.join(diagDir, "access_denied.png"), fullPage: true }).catch(() => {});
            
            const cookies = await page.context().cookies();
            await fs.writeJson(path.join(diagDir, "cookies.json"), cookies, { spaces: 2 });
            await fs.writeJson(path.join(diagDir, "headers.json"), headers, { spaces: 2 });
            await fs.writeJson(path.join(diagDir, "fingerprint.json"), fingerprint, { spaces: 2 });
            
            logger.info(`Saved Access Denied diagnostics folder to: ${diagDir}`);
        } catch (saveErr) {
            logger.error(`Failed to save Access Denied diagnostics: ${saveErr.message}`);
        }
    }
    
    return {
        isAccessDenied,
        isCaptcha,
        isLoginPage,
        isTimeout,
        isNetworkError,
        classification,
        finalUrl,
        status,
        pageTitle,
        first500: firstSnippet
    };
}

async function navigateAndCheck(page, url, options, logger, isLandingPage = false) {
    if (!url.startsWith("https://") && url !== "about:blank") {
        throw new Error(`HTTPS Verification Failed: Requested URL is non-HTTPS: ${url}`);
    }

    let response = null;
    let error = null;
    try {
        response = await page.goto(url, options);
    } catch (err) {
        error = err;
    }

    const finalUrl = page.url();
    if (!finalUrl.startsWith("https://") && finalUrl !== "about:blank") {
        throw new Error(`HTTPS Verification Failed: Final URL is non-HTTPS: ${finalUrl}`);
    }

    if (response) {
        const req = response.request();
        if (req) {
            let currentReq = req.redirectedFrom();
            while (currentReq) {
                if (!currentReq.url().startsWith("https://")) {
                    throw new Error(`HTTPS Verification Failed: Redirect chain contains non-HTTPS URL: ${currentReq.url()}`);
                }
                currentReq = currentReq.redirectedFrom();
            }
        }
    }

    const diag = await runDiagnostics(url, page, response, error, logger, isLandingPage);
    
    // Save cookies to logs/cookies.json immediately after navigation
    try {
        const cookies = await page.context().cookies();
        const logsDir = path.join(process.cwd(), "logs");
        await fs.ensureDir(logsDir);
        await fs.writeJson(path.join(logsDir, "cookies.json"), cookies, { spaces: 2 });
    } catch (cookieErr) {
        logger.warn(`Failed to save cookies to logs/cookies.json: ${cookieErr.message}`);
    }

    if (diag.isAccessDenied) {
        logger.error(`Access Denied detected for ${url}. Stopping immediately.`);
        
        const alertMsg = `🚨 *ACCESS DENIED ALERT*\n\n` +
                         `An Access Denied page was detected during Naukri navigation.\n\n` +
                         `*Navigation Details*:\n` +
                         `• *Attempted URL*: ${url}\n` +
                         `• *Final URL*: ${diag.finalUrl}\n` +
                         `• *HTTP Status*: ${diag.status || "N/A"}\n` +
                         `• *Page Title*: \`${diag.pageTitle}\`\n\n` +
                         `*Diagnostics*:\n` +
                         `• *Classification*: \`${diag.classification}\`\n\n` +
                         `Stopping execution immediately. Do not retry login.`;
        await telegramService.sendMessage(alertMsg);
        
        throw new Error(`Access Denied page detected during Naukri login navigation.`);
    }
    
    if (error) {
        throw error;
    }
    
    return response;
}

/**
 * Naukri Login Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 */
module.exports = async function login(plugin, page) {
    const { logger, config } = plugin;
    logger.info("Naukri login routine started.");
    
    // Register network trace listeners
    const requestListener = request => {
        let redirectChain = [];
        try {
            let currentReq = request.redirectedFrom();
            while (currentReq) {
                redirectChain.unshift(currentReq.url());
                currentReq = currentReq.redirectedFrom();
            }
        } catch (e) {}
        logger.info(`[Network Request] URL: ${request.url()} | Method: ${request.method()} | ResourceType: ${request.resourceType()} | RedirectChain: ${JSON.stringify(redirectChain)}`);
    };

    const responseListener = response => {
        let redirectChain = [];
        try {
            const request = response.request();
            if (request) {
                let currentReq = request.redirectedFrom();
                while (currentReq) {
                    redirectChain.unshift(currentReq.url());
                    currentReq = currentReq.redirectedFrom();
                }
            }
        } catch (e) {}
        logger.info(`[Network Response] URL: ${response.url()} | Status: ${response.status()} | Method: ${response.request().method()} | Headers: ${JSON.stringify(response.headers())} | RedirectChain: ${JSON.stringify(redirectChain)}`);
    };

    page.on("request", requestListener);
    page.on("response", responseListener);

    try {
        // 1. Detect existing session
        // Navigate to profile page - if authenticated, it loads profile directly. 
        // If not, it redirects to landing or login.
        logger.info("Verifying active login state...");
        try {
            await navigateAndCheck(page, "https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 15000 }, logger, true);
            if (await plugin.health(page)) {
                logger.info("Existing authenticated session detected on homepage.");
                return true;
            }
        } catch (e) {
            if (e.message.includes("Access Denied")) {
                throw e;
            }
            logger.warn(`Session check navigation failed: ${e.message}. Proceeding to login.`);
            await page.goto("about:blank").catch(() => {});
        }

        // 2. Direct to login page
        const loginUrl = "https://www.naukri.com/nlogin/login";
        logger.info(`Navigating to login page: ${loginUrl}`);
        await navigateAndCheck(page, loginUrl, { waitUntil: "networkidle", timeout: 30000 }, logger);
        
        const email = config.portals.naukri.email;
        const password = config.portals.naukri.password;
        if (!email || !password) {
            throw new Error("Missing Naukri email/password in configurations.");
        }
        
        // 3. Fill and submit credentials
        logger.info("Entering credentials via simulated human keystrokes...");
        await page.waitForSelector("#usernameField", { timeout: 10000 });
        
        // Type email
        await page.click("#usernameField");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        for (const char of email) {
            await page.keyboard.type(char);
            await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
        }
        
        // Type password
        await page.click("#passwordField");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        for (const char of password) {
            await page.keyboard.type(char);
            await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
        }
        
        logger.info("Submitting login form...");
        await page.click('button[type="submit"]');
        
        // Wait for redirect to profile page to complete naturally
        logger.info("Waiting for post-login redirection to complete...");
        await page.waitForURL("**/mnj/profile**", { timeout: 25000 }).catch(() => {
            logger.warn("Did not detect redirect to profile page within timeout.");
        });
        
        // Settle delay to let session cookies write to persistent context
        await page.waitForTimeout(5000);
        
        const isLoggedIn = await plugin.health(page);
        if (isLoggedIn) {
            logger.info("Authentication verification successful.");
            return true;
        } else {
            logger.error("Authentication failed. Session verification indicated offline.");
            return false;
        }
    } finally {
        page.off("request", requestListener);
        page.off("response", responseListener);
    }
};
