const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BaseATSAdapter {
    constructor(atsName = "GENERIC") {
        this.atsName = atsName;
    }

    /**
     * Check if page requires authentication, MFA, OTP, CAPTCHA, or security check
     * @param {import('playwright').Page} page 
     * @returns {Promise<{ blocked: boolean, reason?: string, details?: string }>}
     */
    async detectAuthOrCaptcha(page) {
        try {
            const result = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                const html = document.documentElement ? document.documentElement.innerHTML.toLowerCase() : "";

                // CAPTCHA detection
                if (html.includes("g-recaptcha") || html.includes("h-captcha") || html.includes("cf-turnstile") ||
                    text.includes("verify you are human") || text.includes("security check") || text.includes("captcha")) {
                    return { blocked: true, reason: "CAPTCHA_REQUIRED", details: "CAPTCHA or bot protection challenge detected." };
                }

                // OTP / MFA detection
                if (text.includes("enter otp") || text.includes("verification code") || text.includes("two-factor authentication") || text.includes("sent code to your email")) {
                    return { blocked: true, reason: "OTP_REQUIRED", details: "MFA / OTP verification requested." };
                }

                // Account / Login detection (where login is mandatory before form access)
                const hasPasswordInput = !!document.querySelector('input[type="password"]');
                const isLoginForm = (text.includes("sign in to apply") || text.includes("log in to your account") || text.includes("create an account to apply")) && hasPasswordInput;
                if (isLoginForm) {
                    return { blocked: true, reason: "AUTH_REQUIRED", details: "Mandatory account login or registration required." };
                }

                return { blocked: false };
            }).catch(() => ({ blocked: false }));

            return result;
        } catch (err) {
            logger.warn(`Auth/Captcha detection warning on ${this.atsName}: ${err.message}`);
            return { blocked: false };
        }
    }

    /**
     * Upload resume file
     * @param {import('playwright').Page} page 
     * @param {string} resumePath Absolute path to resume PDF
     * @returns {Promise<boolean>}
     */
    async uploadResume(page, resumePath) {
        if (!resumePath) return false;
        try {
            const fileInputs = page.locator('input[type="file"]');
            const count = await fileInputs.count().catch(() => 0);
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    const input = fileInputs.nth(i);
                    const isVisible = await input.isVisible().catch(() => true);
                    const accept = (await input.getAttribute("accept").catch(() => "") || "").toLowerCase();
                    if (!accept || accept.includes("pdf") || accept.includes("doc") || accept.includes("*")) {
                        await input.setInputFiles(resumePath).catch(() => {});
                        logger.info(`✓ Resume uploaded via input #${i + 1} on ${this.atsName}`);
                        await delay(2000);
                        return true;
                    }
                }
            }
        } catch (err) {
            logger.warn(`Resume upload warning on ${this.atsName}: ${err.message}`);
        }
        return false;
    }

    /**
     * Common layered submission verification
     * @param {import('playwright').Page} page 
     * @returns {Promise<{ verified: boolean, status: string, details?: string }>}
     */
    async verifySubmission(page) {
        await delay(4000);

        try {
            const postSubmitState = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                const url = window.location.href.toLowerCase();

                const successPhrases = [
                    "application submitted",
                    "thank you for applying",
                    "thanks for applying",
                    "application received",
                    "successfully submitted",
                    "your application has been submitted",
                    "application complete",
                    "thank you for your interest"
                ];

                const isSuccessText = successPhrases.some(phrase => text.includes(phrase));
                const isSuccessUrl = url.includes("confirmation") || url.includes("thank-you") || url.includes("thanks") || url.includes("submitted") || url.includes("success");

                return { isSuccessText, isSuccessUrl, textSnippet: text.substring(0, 300) };
            }).catch(() => ({ isSuccessText: false, isSuccessUrl: false }));

            if (postSubmitState.isSuccessText || postSubmitState.isSuccessUrl) {
                return {
                    verified: true,
                    status: "EMPLOYER_PENDING",
                    details: postSubmitState.isSuccessText ? "UI Thank You / Submitted message confirmed" : "Post-submit confirmation URL pattern confirmed"
                };
            }

            // Perform reload check as secondary verification
            await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await delay(3000);

            const reloadedText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : "").catch(() => "");
            if (reloadedText.includes("already applied") || reloadedText.includes("application submitted") || reloadedText.includes("thank you for applying")) {
                return {
                    verified: true,
                    status: "EMPLOYER_PENDING",
                    details: "Confirmed via page reload DOM inspection"
                };
            }
        } catch (err) {
            logger.warn(`Submission verification warning on ${this.atsName}: ${err.message}`);
        }

        return {
            verified: false,
            status: "CLICKED_UNVERIFIED",
            details: "Submit clicked but no positive post-submission evidence detected."
        };
    }
}

module.exports = BaseATSAdapter;
