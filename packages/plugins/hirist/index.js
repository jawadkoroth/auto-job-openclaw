const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class HiristPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        this.logger.info("Hirist logout initiated.");
        try {
            await page.click("a:has-text('Logout')").catch(() => {});
        } catch (e) {
            // ignore
        }
        return true;
    }

    async updateProfile(page) {
        return profile(this, page);
    }

    async search(page, queryOptions) {
        return search(this, page, queryOptions);
    }

    async apply(page, job) {
        return apply(this, page, job);
    }

    async health(page) {
        try {
            let currentUrl = page.url();
            let isLoggedIn = false;
            
            // Gather indicators for the current page
            let matchedAuthIndicators = [];
            const logoutCount = await page.locator("a[href*='logout'], a:has-text('Logout')").count();
            if (logoutCount > 0) matchedAuthIndicators.push(`Logout link (${logoutCount})`);
            const profileCount = await page.locator("a[href*='profile.html'], a:has-text('My Profile'), a:has-text('Edit Profile')").count();
            if (profileCount > 0) matchedAuthIndicators.push(`Profile link (${profileCount})`);
            const jobfeedCount = await page.locator("a[href*='jobfeed'], a:has-text('Job Feed')").count();
            if (jobfeedCount > 0) matchedAuthIndicators.push(`Jobfeed link (${jobfeedCount})`);
            const isUrlJobfeed = currentUrl.includes("hirist.tech/jobfeed");
            if (isUrlJobfeed) matchedAuthIndicators.push("URL contains jobfeed");

            const matchedLoginIndicators = [];
            const loginFormCount = await page.locator("form#login-form, form[action*='login'], button#loginSubmit, input[type='password']").count();
            if (loginFormCount > 0) matchedLoginIndicators.push(`Login form/input/submit (${loginFormCount})`);
            const loginButtonCount = await page.locator("a:has-text('Login'), button:has-text('Login'), p:has-text('Login'), div.login-btn").count();
            if (loginButtonCount > 0) matchedLoginIndicators.push(`Login button (${loginButtonCount})`);
            
            // Classify state on the current page
            let classification = "NOT_AUTHENTICATED";
            let reason = "";

            const parsedUrl = new URL(currentUrl);
            const isHomepage = parsedUrl.pathname === "/" || parsedUrl.pathname === "";
            
            if (isHomepage) {
                classification = "UNAUTHENTICATED_HOMEPAGE";
                reason = "homepage is unauthenticated";
            } else if (currentUrl.includes("/login") || currentUrl.includes("/signup") || currentUrl.includes("/register") || currentUrl.includes("/otp")) {
                classification = "UNAUTHENTICATED_AUTH_PAGE";
                reason = "explicit login/signup/register/otp page";
            } else if (loginFormCount > 0) {
                classification = "UNAUTHENTICATED_LOGIN_FORM_PRESENT";
                reason = "login form/password input detected";
            } else {
                const hasPositiveAuth = logoutCount > 0 || (profileCount > 0 && loginButtonCount === 0) || jobfeedCount > 0 || isUrlJobfeed;
                if (hasPositiveAuth) {
                    isLoggedIn = true;
                    classification = "AUTHENTICATED";
                    reason = "positive authenticated indicators matched and no login form present";
                } else {
                    classification = "UNAUTHENTICATED_NO_INDICATORS";
                    reason = "no positive authenticated indicators matched";
                }
            }

            this.logger.debug(`[hirist auth check] URL: ${currentUrl}`);
            this.logger.debug(`[hirist auth check] Matched Auth Indicators: [${matchedAuthIndicators.join(", ")}]`);
            this.logger.debug(`[hirist auth check] Matched Login Indicators: [${matchedLoginIndicators.join(", ")}]`);
            this.logger.debug(`[hirist auth check] Classification: ${classification} (${reason})`);

            // If not authenticated on the current page, and NOT in HEADFUL_AUTH_SETUP mode, navigate to profile.html to check
            if (!isLoggedIn && process.env.HEADFUL_AUTH_SETUP !== "true") {
                const isProfileOrJobfeedUrl = currentUrl.includes("hirist.tech/profile.html") || currentUrl.includes("hirist.tech/jobfeed");
                if (!isProfileOrJobfeedUrl) {
                    this.logger.info("Not on profile/jobfeed page and not authenticated. Navigating to Hirist profile page...");
                    await page.goto("https://www.hirist.tech/profile.html", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
                    currentUrl = page.url();
                    
                    // Re-gather indicators after navigation
                    matchedAuthIndicators = [];
                    const logoutCount2 = await page.locator("a[href*='logout'], a:has-text('Logout')").count();
                    if (logoutCount2 > 0) matchedAuthIndicators.push(`Logout link (${logoutCount2})`);
                    const profileCount2 = await page.locator("a[href*='profile.html'], a:has-text('My Profile'), a:has-text('Edit Profile')").count();
                    if (profileCount2 > 0) matchedAuthIndicators.push(`Profile link (${profileCount2})`);
                    const jobfeedCount2 = await page.locator("a[href*='jobfeed'], a:has-text('Job Feed')").count();
                    if (jobfeedCount2 > 0) matchedAuthIndicators.push(`Jobfeed link (${jobfeedCount2})`);
                    const isUrlJobfeed2 = currentUrl.includes("hirist.tech/jobfeed");
                    if (isUrlJobfeed2) matchedAuthIndicators.push("URL contains jobfeed");

                    matchedLoginIndicators = [];
                    const loginFormCount2 = await page.locator("form#login-form, form[action*='login'], button#loginSubmit, input[type='password']").count();
                    if (loginFormCount2 > 0) matchedLoginIndicators.push(`Login form/input/submit (${loginFormCount2})`);
                    const loginButtonCount2 = await page.locator("a:has-text('Login'), button:has-text('Login'), p:has-text('Login'), div.login-btn").count();
                    if (loginButtonCount2 > 0) matchedLoginIndicators.push(`Login button (${loginButtonCount2})`);
                    
                    const parsedUrl2 = new URL(currentUrl);
                    const isHomepage2 = parsedUrl2.pathname === "/" || parsedUrl2.pathname === "";
                    
                    if (isHomepage2) {
                        classification = "UNAUTHENTICATED_HOMEPAGE";
                        reason = "homepage is unauthenticated";
                    } else if (currentUrl.includes("/login") || currentUrl.includes("/signup") || currentUrl.includes("/register") || currentUrl.includes("/otp")) {
                        classification = "UNAUTHENTICATED_AUTH_PAGE";
                        reason = "explicit login/signup/register/otp page";
                    } else if (loginFormCount2 > 0) {
                        classification = "UNAUTHENTICATED_LOGIN_FORM_PRESENT";
                        reason = "login form/password input detected";
                    } else {
                        const hasPositiveAuth2 = logoutCount2 > 0 || (profileCount2 > 0 && loginButtonCount2 === 0) || jobfeedCount2 > 0 || isUrlJobfeed2;
                        if (hasPositiveAuth2) {
                            isLoggedIn = true;
                            classification = "AUTHENTICATED";
                            reason = "positive authenticated indicators matched and no login form present";
                        } else {
                            classification = "UNAUTHENTICATED_NO_INDICATORS";
                            reason = "no positive authenticated indicators matched";
                        }
                    }

                    this.logger.debug(`[hirist auth check post-nav] URL: ${currentUrl}`);
                    this.logger.debug(`[hirist auth check post-nav] Matched Auth Indicators: [${matchedAuthIndicators.join(", ")}]`);
                    this.logger.debug(`[hirist auth check post-nav] Matched Login Indicators: [${matchedLoginIndicators.join(", ")}]`);
                    this.logger.debug(`[hirist auth check post-nav] Classification: ${classification} (${reason})`);
                }
            }
            
            const contextManager = require("../../browser/ContextManager");
            const currentMeta = await contextManager.getMetadata(this.name);
            const nextHealth = isLoggedIn ? "healthy" : "auth_required";
            
            if (currentMeta.sessionHealth !== nextHealth) {
                await contextManager.updateMetadata(this.name, { sessionHealth: nextHealth }).catch(() => {});
            }
            return isLoggedIn;
        } catch (e) {
            const contextManager = require("../../browser/ContextManager");
            const currentMeta = await contextManager.getMetadata(this.name).catch(() => ({}));
            if (currentMeta.sessionHealth !== "auth_required") {
                await contextManager.updateMetadata(this.name, { sessionHealth: "auth_required" }).catch(() => {});
            }
            return false;
        }
    }
}

module.exports = HiristPlugin;
