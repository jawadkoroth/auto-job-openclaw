const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GenericFormAdapter extends BaseATSAdapter {
    constructor() {
        super("GENERIC_FORM");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[GenericFormAdapter] Analyzing external application page...");

        // 1. Stage Navigation: Ensure we are on the actual application form stage
        await this.navigateToFormStage(page);

        // 2. Check Security / Auth / CAPTCHA Requirements
        const authCheck = await this.detectAuthOrCaptcha(page);
        if (authCheck.blocked) {
            logger.warn(`⚠️ [GenericFormAdapter] Halted by security/auth constraint: ${authCheck.reason} (${authCheck.details})`);
            return {
                success: false,
                status: authCheck.reason,
                reasonCode: authCheck.reason,
                details: authCheck.details
            };
        }

        // 3. Form Analysis & Question Resolution
        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);

        // Fill all resolved fields
        for (const item of analysis.answers) {
            if (item.element && item.value) {
                const sel = item.element.id ? `#${item.element.id}` : `[name="${item.element.name}"]`;
                try {
                    const loc = page.locator(sel).first();
                    if (await loc.count().catch(() => 0) > 0) {
                        const currentVal = await loc.inputValue().catch(() => "");
                        if (!currentVal) {
                            if (item.type === "select" || item.type === "select-one") {
                                await loc.selectOption({ label: item.value }).catch(() => loc.selectOption({ value: item.value })).catch(() => {});
                            } else if (item.type === "radio" || item.type === "checkbox") {
                                if (String(item.value).toLowerCase() === "yes" || String(item.value) === "true") {
                                    await loc.check().catch(() => {});
                                }
                            } else {
                                await loc.fill(String(item.value)).catch(() => {});
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        // 4. Identify Submit Control
        const submitBtnLocators = [
            page.locator('button[type="submit"]'),
            page.locator('input[type="submit"]'),
            page.locator('button:has-text("Submit Application")'),
            page.locator('button:has-text("Submit")'),
            page.locator('button:has-text("Send Application")')
        ];

        let submitBtnVisible = false;
        for (const btn of submitBtnLocators) {
            if (await btn.count().catch(() => 0) > 0 && await btn.first().isVisible().catch(() => false)) {
                submitBtnVisible = true;
                break;
            }
        }

        // 5. Pre-Submission Safety Validation Gate (FORM_READY)
        const readyCheck = this.validateFormReady({
            isSafeToSubmit: analysis.isSafeToSubmit,
            unresolvedRequired: analysis.unresolvedRequired,
            authCheck,
            submitBtnVisible
        });

        if (!readyCheck.isReady) {
            logger.warn(`⚠️ [GenericFormAdapter] Form not ready for submission: ${readyCheck.reasonCode} (${readyCheck.blockers.join('; ')})`);
            return {
                success: false,
                status: readyCheck.status,
                reasonCode: readyCheck.reasonCode,
                details: readyCheck.blockers.join('; '),
                unresolvedRequired: analysis.unresolvedRequired
            };
        }

        logger.info(`✓ [GenericFormAdapter] State: FORM_READY. Pre-submission safety checks passed.`);
        return { success: true, status: "FORM_READY" };
    }

    async submit(page) {
        logger.info("[GenericFormAdapter] Submitting generic form...");
        const submitBtnLocators = [
            page.locator('button[type="submit"]'),
            page.locator('input[type="submit"]'),
            page.locator('button:has-text("Submit Application")'),
            page.locator('button:has-text("Submit")'),
            page.locator('button:has-text("Send Application")')
        ];

        for (const btn of submitBtnLocators) {
            if (await btn.count().catch(() => 0) > 0 && await btn.first().isVisible().catch(() => false)) {
                await btn.first().click().catch(() => {});
                await delay(3000);
                return true;
            }
        }
        return false;
    }
}

module.exports = new GenericFormAdapter();
