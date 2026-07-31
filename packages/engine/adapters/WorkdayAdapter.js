const BaseATSAdapter = require("./BaseATSAdapter");
const workdaySessionManager = require("../auth/WorkdaySessionManager");
const externalSessionManager = require("../auth/ExternalSessionManager");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WorkdayAdapter extends BaseATSAdapter {
    constructor() {
        super("WORKDAY");
    }

    /**
     * Check if page requires authentication, MFA, OTP, CAPTCHA, or security check
     */
    async detectAuthOrCaptcha(page) {
        const baseAuth = await super.detectAuthOrCaptcha(page);
        if (baseAuth.blocked) return baseAuth;

        const sessionCheck = await workdaySessionManager.validateSession(page);
        if (!sessionCheck.authenticated) {
            const tenantKey = workdaySessionManager.getTenantKey(page.url());
            return {
                blocked: true,
                reason: "AUTH_REQUIRED",
                details: `Workday tenant (${tenantKey}) requires manual candidate authentication. Bootstrap via: node scripts/setup-workday-session.js "${page.url()}"`
            };
        }

        return { blocked: false };
    }

    /**
     * Process Workday multi-step application form
     */
    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[WorkdayAdapter] Processing Workday job application flow...");

        const tenantKey = workdaySessionManager.getTenantKey(page.url());
        const hasStoredSession = workdaySessionManager.hasValidSession(page.url());

        if (!hasStoredSession) {
            logger.warn(`⚠️ [WorkdayAdapter] No stored session found for Workday tenant: ${tenantKey}`);
            return {
                success: false,
                status: "AUTH_REQUIRED",
                reasonCode: "AUTH_REQUIRED",
                details: `Workday tenant (${tenantKey}) requires candidate session bootstrap. Run: node scripts/setup-workday-session.js "${page.url()}"`
            };
        }

        // Click 'Apply' / 'Apply Manually' button if present on job landing page
        const applyBtnLocators = [
            page.locator('a[data-automation-id="adventureButton"]'),
            page.locator('button[data-automation-id="applyButton"]'),
            page.locator('a:has-text("Apply Manually")'),
            page.locator('button:has-text("Apply Manually")'),
            page.locator('a:has-text("Apply")'),
            page.locator('button:has-text("Apply")')
        ];

        for (const btn of applyBtnLocators) {
            if (await btn.count().catch(() => 0) > 0 && await btn.first().isVisible().catch(() => false)) {
                logger.info(`[WorkdayAdapter] Clicking Workday Apply control...`);
                await btn.first().click().catch(() => {});
                await delay(4000);
                break;
            }
        }

        // Re-validate authenticated candidate state
        const authCheck = await this.detectAuthOrCaptcha(page);
        if (authCheck.blocked) {
            logger.warn(`⚠️ [WorkdayAdapter] Auth requirement active on ${tenantKey}: ${authCheck.reason}`);
            return {
                success: false,
                status: authCheck.reason,
                reasonCode: authCheck.reason,
                details: authCheck.details
            };
        }

        // Perform questionnaire analysis & form completion
        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);

        // Fill all resolved fields with stable data-automation-id fallback
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
                            } else {
                                await loc.fill(String(item.value)).catch(() => {});
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        // Identify Submit Control
        const submitBtnLocators = [
            page.locator('button[data-automation-id="bottom-navigation-next-button"]'),
            page.locator('button[data-automation-id="submitButton"]'),
            page.locator('button:has-text("Submit")')
        ];

        let submitBtnVisible = false;
        for (const btn of submitBtnLocators) {
            if (await btn.count().catch(() => 0) > 0 && await btn.first().isVisible().catch(() => false)) {
                submitBtnVisible = true;
                break;
            }
        }

        // Validate Pre-Submission Safety Gate (FORM_READY)
        const readyCheck = this.validateFormReady({
            isSafeToSubmit: analysis.isSafeToSubmit,
            unresolvedRequired: analysis.unresolvedRequired,
            authCheck,
            submitBtnVisible
        });

        if (!readyCheck.isReady) {
            logger.warn(`⚠️ [WorkdayAdapter] Form not ready for submission: ${readyCheck.reasonCode} (${readyCheck.blockers.join('; ')})`);
            return {
                success: false,
                status: readyCheck.status,
                reasonCode: readyCheck.reasonCode,
                details: readyCheck.blockers.join('; '),
                unresolvedRequired: analysis.unresolvedRequired
            };
        }

        logger.info(`✓ [WorkdayAdapter] State: FORM_READY. Pre-submission safety checks passed for Workday.`);
        return { success: true, status: "FORM_READY" };
    }

    async submit(page) {
        logger.info("[WorkdayAdapter] Submitting Workday application...");
        const submitBtnLocators = [
            page.locator('button[data-automation-id="bottom-navigation-next-button"]'),
            page.locator('button[data-automation-id="submitButton"]'),
            page.locator('button:has-text("Submit")')
        ];

        for (const btn of submitBtnLocators) {
            if (await btn.count().catch(() => 0) > 0 && await btn.first().isVisible().catch(() => false)) {
                await btn.first().click().catch(() => {});
                await delay(4000);
                return true;
            }
        }
        return false;
    }
}

module.exports = new WorkdayAdapter();
