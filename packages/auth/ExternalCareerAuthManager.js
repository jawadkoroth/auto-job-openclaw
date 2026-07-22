const fs = require("fs");
const path = require("path");
const logger = require("../logger");
const Telegram = require("../../apps/telegram");
const gmailOtpManager = require("./GmailOtpManager");
const externalApplicationRouter = require("../router/ExternalApplicationRouter");

class ExternalCareerAuthManager {
    constructor() {
        this.email = process.env.EXTERNAL_CAREER_EMAIL || "jawad.koroth@example.com";
        this.password = process.env.EXTERNAL_CAREER_PASSWORD || "";
    }

    /**
     * Determines whether the current page displays an authentication or account creation form
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>}
     */
    async detectAuthRequired(page) {
        try {
            const currentUrl = page.url() || "";
            if (externalApplicationRouter.isLinkedInUrl(currentUrl) || externalApplicationRouter.isIndeedUrl(currentUrl)) {
                return false;
            }

            const passwordField = page.locator("input[type='password']").first();
            if (await passwordField.count() > 0 && await passwordField.isVisible().catch(() => false)) {
                return true;
            }

            const loginButtons = page.locator("button:has-text('Sign In'), button:has-text('Log In'), button:has-text('Register'), a:has-text('Sign In'), a:has-text('Create Account')");
            if (await loginButtons.count() > 0 && await loginButtons.first().isVisible().catch(() => false)) {
                const inputs = await page.locator("input").count();
                if (inputs <= 4) {
                    return true;
                }
            }

            return false;
        } catch {
            return false;
        }
    }

    /**
     * Handles authentication or account registration for an external career portal
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     * @returns {Promise<{ authenticated: boolean, existingSessionUsed: boolean, existingAccountLogin: boolean, newAccountCreated: boolean, otpRequired: boolean, otpRetrieved: boolean, captchaEncountered: boolean, isIntermediaryDomain?: boolean }>}
     */
    async handleAuth(page, job) {
        const result = {
            authenticated: false,
            existingSessionUsed: false,
            existingAccountLogin: false,
            newAccountCreated: false,
            otpRequired: false,
            otpRetrieved: false,
            captchaEncountered: false
        };

        const currentUrl = page.url() || "";
        if (externalApplicationRouter.isLinkedInUrl(currentUrl) || externalApplicationRouter.isIndeedUrl(currentUrl)) {
            logger.worker.warn(`[External Career Auth] Aborting generic auth on Intermediary URL (${currentUrl}). Generic career credentials will NEVER be used on LinkedIn or Indeed.`);
            result.isIntermediaryDomain = true;
            return result;
        }

        const isAuthNeeded = await this.detectAuthRequired(page);
        if (!isAuthNeeded) {
            result.authenticated = true;
            return result;
        }

        logger.worker.info(`[External Career Auth] Authentication UI detected for ${job.company || "Company"} (${job.ats || "ATS"}).`);

        // Check for active CAPTCHA / anti-bot
        const captchaFrame = page.locator("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='cf-challenge'], div.g-recaptcha");
        if (await captchaFrame.count() > 0 && await captchaFrame.first().isVisible().catch(() => false)) {
            logger.worker.warn(`[External Career Auth] Active CAPTCHA/anti-bot challenge detected! Triggering WAITING_FOR_INPUT.`);
            result.captchaEncountered = true;
            await Telegram.sendMessage(
                `⚠️ <b>CAPTCHA Challenge Required</b>\n\n<b>Job:</b> ${job.title} at ${job.company}\n<b>Portal:</b> ${job.ats}\n\nPlease solve the CAPTCHA in the browser window.`
            ).catch(() => {});
            return result;
        }

        const email = process.env.EXTERNAL_CAREER_EMAIL || "jawad.koroth@example.com";
        const password = process.env.EXTERNAL_CAREER_PASSWORD || "SecureCandidatePass2026!";

        if (!password) {
            logger.worker.warn(`[External Career Auth] EXTERNAL_CAREER_PASSWORD is not set in environment. Cannot perform automated login.`);
            return result;
        }

        try {
            // STEP A: Try Login
            const emailInput = page.locator("input[type='email'], input[name*='email'], input[name*='user'], input[id*='email']").first();
            const passwordInput = page.locator("input[type='password']").first();

            if (await emailInput.count() > 0 && await passwordInput.count() > 0) {
                logger.worker.info(`[External Career Auth] Attempting login with candidate email...`);
                await emailInput.fill(email);
                await passwordInput.fill(password);

                const signInBtn = page.locator("button[type='submit'], button:has-text('Sign In'), button:has-text('Log In'), input[type='submit']").first();
                if (await signInBtn.count() > 0) {
                    await signInBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(4000);
                }

                // Check if logged in successfully
                const postLoginAuthNeeded = await this.detectAuthRequired(page);
                if (!postLoginAuthNeeded) {
                    logger.worker.info(`[External Career Auth] Login successful.`);
                    result.authenticated = true;
                    result.existingAccountLogin = true;
                    return result;
                }

                // STEP B: Check if account does not exist -> Register
                const pageText = (await page.content().catch(() => "")).toLowerCase();
                const accountNotFound = pageText.includes("account not found") || pageText.includes("user does not exist") || pageText.includes("invalid credentials") || pageText.includes("no account");

                if (accountNotFound) {
                    logger.worker.info(`[External Career Auth] Account not found. Looking for registration/signup...`);
                    const registerLink = page.locator("a:has-text('Create Account'), a:has-text('Register'), a:has-text('Sign Up'), button:has-text('Create Account')").first();
                    if (await registerLink.count() > 0) {
                        await registerLink.click({ force: true }).catch(() => {});
                        await page.waitForTimeout(3000);

                        // STEP C: Register candidate account
                        const regEmail = page.locator("input[type='email'], input[name*='email']").first();
                        const regPass = page.locator("input[type='password']").first();
                        const regConfirmPass = page.locator("input[name*='confirm'], input[id*='confirm']").first();

                        if (await regEmail.count() > 0 && await regPass.count() > 0) {
                            logger.worker.info(`[External Career Auth] Creating new candidate account...`);
                            await regEmail.fill(email);
                            await regPass.fill(password);
                            if (await regConfirmPass.count() > 0) {
                                await regConfirmPass.fill(password);
                            }

                            // STEP D: Accept required terms/privacy policy
                            const termsCheckbox = page.locator("input[type='checkbox'][name*='term'], input[type='checkbox'][name*='privacy'], input[type='checkbox'][id*='agree']").first();
                            if (await termsCheckbox.count() > 0 && !(await termsCheckbox.isChecked())) {
                                await termsCheckbox.check({ force: true }).catch(() => {});
                            }

                            const createAccountSubmit = page.locator("button[type='submit'], button:has-text('Create'), button:has-text('Register')").first();
                            if (await createAccountSubmit.count() > 0) {
                                await createAccountSubmit.click({ force: true }).catch(() => {});
                                await page.waitForTimeout(5000);
                                result.newAccountCreated = true;
                            }
                        }
                    }
                }
            }

            // STEP F: Check for OTP or Verification Code
            const otpInput = page.locator("input[name*='otp'], input[name*='code'], input[placeholder*='code'], input[id*='otp']").first();
            if (await otpInput.count() > 0 && await otpInput.isVisible().catch(() => false)) {
                logger.worker.info(`[External Career Auth] OTP / Verification Code field detected. Requesting Gmail OTP...`);
                result.otpRequired = true;

                const otpCode = await gmailOtpManager.fetchOtp({
                    jobId: job.id || job.job_id,
                    company: job.company,
                    atsDomain: new URL(page.url()).hostname,
                    purpose: "EMAIL_VERIFICATION",
                    requestTime: Date.now()
                });

                if (otpCode) {
                    logger.worker.info(`[External Career Auth] OTP retrieved successfully. Filling code...`);
                    await otpInput.fill(otpCode);
                    const verifyBtn = page.locator("button:has-text('Verify'), button:has-text('Submit'), button[type='submit']").first();
                    if (await verifyBtn.count() > 0) {
                        await verifyBtn.click({ force: true }).catch(() => {});
                        await page.waitForTimeout(4000);
                    }
                    result.otpRetrieved = true;
                    result.authenticated = true;
                    return result;
                } else {
                    logger.worker.warn(`[External Career Auth] Failed to retrieve OTP within timeout.`);
                    return result;
                }
            }

            const finalAuthCheck = await this.detectAuthRequired(page);
            result.authenticated = !finalAuthCheck;

            return result;
        } catch (err) {
            logger.worker.error(`[External Career Auth] Exception during authentication handling: ${err.message}`);
            return result;
        }
    }
}

module.exports = new ExternalCareerAuthManager();
