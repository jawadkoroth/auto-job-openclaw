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
                const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], textarea[name="g-recaptcha-response"]');
                if (hasRecaptcha || html.includes("g-recaptcha") || html.includes("h-captcha") || html.includes("cf-turnstile") ||
                    text.includes("verify you are human") || text.includes("security check") || text.includes("captcha")) {
                    return { blocked: true, reason: "CAPTCHA_REQUIRED", details: "CAPTCHA or bot protection challenge detected on page." };
                }

                // OTP / MFA detection
                if (text.includes("enter otp") || text.includes("verification code") || text.includes("two-factor authentication") || text.includes("sent code to your email")) {
                    return { blocked: true, reason: "OTP_REQUIRED", details: "MFA / OTP verification requested." };
                }

                // Account / Login detection
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
     * Navigate landing page stage buttons (e.g. "Apply", "Apply Now") if form is not initially open
     * @param {import('playwright').Page} page 
     * @returns {Promise<boolean>}
     */
    async navigateToFormStage(page) {
        try {
            const initialInputs = await page.locator('input:not([type="hidden"]), select, textarea').count().catch(() => 0);
            if (initialInputs > 0) {
                return true; // Form controls already present on page
            }

            logger.info(`[${this.atsName}] No initial form inputs detected. Searching for stage opener controls ("Apply", "Apply Now")...`);
            const stageBtnLocators = [
                page.locator('button:has-text("Apply Now")'),
                page.locator('a:has-text("Apply Now")'),
                page.locator('button:has-text("Apply")'),
                page.locator('a:has-text("Apply")'),
                page.locator('[class*="apply"]')
            ];

            for (const loc of stageBtnLocators) {
                if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                    const txt = (await loc.first().textContent().catch(() => "")).trim();
                    if (txt.toLowerCase() === 'apply' || txt.toLowerCase() === 'apply now' || txt.toLowerCase().includes('apply for')) {
                        logger.info(`[${this.atsName}] Clicking stage control "${txt}"...`);
                        await loc.first().click().catch(() => {});
                        await delay(4000);
                        return true;
                    }
                }
            }
        } catch (err) {
            logger.warn(`Stage navigation error on ${this.atsName}: ${err.message}`);
        }
        return false;
    }

    /**
     * Upload resume file and verify upload state
     * @param {import('playwright').Page} page 
     * @param {string} resumePath Absolute path to resume PDF
     * @returns {Promise<{ attached: boolean, evidence?: string }>}
     */
    async uploadResume(page, resumePath) {
        if (!resumePath) return { attached: false, evidence: "NO_RESUME_PATH" };
        try {
            const fileInputs = page.locator('input[type="file"]');
            const count = await fileInputs.count().catch(() => 0);
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    const input = fileInputs.nth(i);
                    const accept = (await input.getAttribute("accept").catch(() => "") || "").toLowerCase();
                    if (!accept || accept.includes("pdf") || accept.includes("doc") || accept.includes("*")) {
                        await input.setInputFiles(resumePath).catch(() => {});
                        logger.info(`✓ Resume set via file input #${i + 1} on ${this.atsName}`);
                        await delay(2500);

                        // Verify upload evidence from DOM
                        const hasUploadedText = await page.evaluate(() => {
                            const text = document.body ? document.body.innerText.toLowerCase() : "";
                            return text.includes(".pdf") || text.includes("uploaded") || text.includes("file attached") || text.includes("resume");
                        }).catch(() => false);

                        return {
                            attached: true,
                            evidence: hasUploadedText ? "Filename or pdf text confirmed in DOM" : "File input set successfully"
                        };
                    }
                }
            }
        } catch (err) {
            logger.warn(`Resume upload warning on ${this.atsName}: ${err.message}`);
        }
        return { attached: false, evidence: "No file input element accessible" };
    }

    /**
     * Validate pre-submission safety gate (FORM_READY)
     * @param {Object} params
     * @returns {{ isReady: boolean, status: string, reasonCode: string, blockers: Array<string> }}
     */
    validateFormReady({ isSafeToSubmit, unresolvedRequired = [], authCheck = {}, resumeAttached = false, submitBtnVisible = false }) {
        const blockers = [];

        if (authCheck.blocked) {
            blockers.push(`Auth/Security challenge active: ${authCheck.reason}`);
            return { isReady: false, status: authCheck.reason, reasonCode: authCheck.reason, blockers };
        }

        if (!isSafeToSubmit || unresolvedRequired.length > 0) {
            const missingField = unresolvedRequired[0]?.label || "Required question unresolved";
            blockers.push(`Unresolved required field: "${missingField}"`);
            return { isReady: false, status: "WAITING_FOR_INPUT", reasonCode: "UNRESOLVED_REQUIRED_FIELD", blockers };
        }

        if (!submitBtnVisible) {
            blockers.push("Final submit action button not identified or visible on form");
            return { isReady: false, status: "SUBMIT_FAILED", reasonCode: "SUBMIT_CONTROL_MISSING", blockers };
        }

        return { isReady: true, status: "FORM_READY", reasonCode: "FORM_READY", blockers: [] };
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
