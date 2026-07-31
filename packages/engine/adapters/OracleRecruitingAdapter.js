const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class OracleRecruitingAdapter extends BaseATSAdapter {
    constructor() {
        super("ORACLE_RECRUITING");
    }

    async detectAuthOrCaptcha(page) {
        const baseAuth = await super.detectAuthOrCaptcha(page);
        if (baseAuth.blocked) return baseAuth;

        try {
            const isLogin = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                return text.includes("sign in") && !!document.querySelector('input[type="password"]');
            }).catch(() => false);

            if (isLogin) {
                return { blocked: true, reason: "AUTH_REQUIRED", details: "Oracle Recruiting Cloud requires user sign-in." };
            }
        } catch (e) {}

        return { blocked: false };
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[OracleRecruitingAdapter] Processing Oracle Recruiting Cloud application...");
        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            return { success: false, status: "WAITING_FOR_INPUT", unresolvedRequired: analysis.unresolvedRequired };
        }
        return { success: true };
    }

    async submit(page) {
        logger.info("[OracleRecruitingAdapter] Submitting Oracle Recruiting Cloud application...");
        const submitBtn = page.locator('button:has-text("Submit"), button:has-text("Apply")').first();
        if (await submitBtn.count().catch(() => 0) > 0 && await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click().catch(() => {});
            await delay(3000);
            return true;
        }
        return false;
    }
}

module.exports = new OracleRecruitingAdapter();
