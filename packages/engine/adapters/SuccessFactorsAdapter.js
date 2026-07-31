const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SuccessFactorsAdapter extends BaseATSAdapter {
    constructor() {
        super("SUCCESSFACTORS");
    }

    async detectAuthOrCaptcha(page) {
        const baseAuth = await super.detectAuthOrCaptcha(page);
        if (baseAuth.blocked) return baseAuth;

        try {
            const isLogin = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                return text.includes("sign in to apply") || text.includes("career opportunities: login") || !!document.querySelector('input[type="password"]');
            }).catch(() => false);

            if (isLogin) {
                return { blocked: true, reason: "AUTH_REQUIRED", details: "SAP SuccessFactors requires account authentication." };
            }
        } catch (e) {}

        return { blocked: false };
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[SuccessFactorsAdapter] Processing SuccessFactors job application...");
        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            return { success: false, status: "WAITING_FOR_INPUT", unresolvedRequired: analysis.unresolvedRequired };
        }
        return { success: true };
    }

    async submit(page) {
        logger.info("[SuccessFactorsAdapter] Submitting SuccessFactors application...");
        const submitBtn = page.locator('button:has-text("Apply"), input[value="Apply"]').first();
        if (await submitBtn.count().catch(() => 0) > 0 && await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click().catch(() => {});
            await delay(3000);
            return true;
        }
        return false;
    }
}

module.exports = new SuccessFactorsAdapter();
