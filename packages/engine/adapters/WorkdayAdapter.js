const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WorkdayAdapter extends BaseATSAdapter {
    constructor() {
        super("WORKDAY");
    }

    async detectAuthOrCaptcha(page) {
        // Workday almost universally requires an account login before application entry
        const baseAuth = await super.detectAuthOrCaptcha(page);
        if (baseAuth.blocked) return baseAuth;

        try {
            const hasLoginButton = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                const hasSignIn = text.includes("sign in") || text.includes("create account") || text.includes("autofill with resume");
                const hasPassword = !!document.querySelector('input[type="password"]');
                return hasSignIn && hasPassword;
            }).catch(() => false);

            if (hasLoginButton) {
                return {
                    blocked: true,
                    reason: "AUTH_REQUIRED",
                    details: "Workday portal requires user account creation / sign-in."
                };
            }
        } catch (e) {}

        return { blocked: false };
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[WorkdayAdapter] Processing Workday job application...");

        // Check if there is an 'Apply' or 'Apply Manually' button to navigate to form
        const applyBtn = page.locator('a[data-automation-id="adventureButton"], button[data-automation-id="applyButton"], a:has-text("Apply Manually")').first();
        if (await applyBtn.count().catch(() => 0) > 0 && await applyBtn.isVisible().catch(() => false)) {
            await applyBtn.click().catch(() => {});
            await delay(3000);
        }

        // Re-check auth requirement after clicking apply button
        const authCheck = await this.detectAuthOrCaptcha(page);
        if (authCheck.blocked) {
            return { success: false, status: authCheck.reason, details: authCheck.details };
        }

        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            return { success: false, status: "WAITING_FOR_INPUT", unresolvedRequired: analysis.unresolvedRequired };
        }

        return { success: true };
    }

    async submit(page) {
        logger.info("[WorkdayAdapter] Submitting Workday application...");
        const submitBtn = page.locator('button[data-automation-id="bottom-navigation-next-button"], button:has-text("Submit")').first();
        if (await submitBtn.count().catch(() => 0) > 0 && await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click().catch(() => {});
            await delay(3000);
            return true;
        }
        return false;
    }
}

module.exports = new WorkdayAdapter();
