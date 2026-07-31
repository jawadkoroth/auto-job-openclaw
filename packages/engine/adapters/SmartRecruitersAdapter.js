const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SmartRecruitersAdapter extends BaseATSAdapter {
    constructor() {
        super("SMARTRECRUITERS");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[SmartRecruitersAdapter] Filling SmartRecruiters job application form...");

        if (candidateProfile.firstName) {
            await page.locator('input[id*="first-name"], input[name*="first-name"]').first().fill(candidateProfile.firstName).catch(() => {});
        }
        if (candidateProfile.lastName) {
            await page.locator('input[id*="last-name"], input[name*="last-name"]').first().fill(candidateProfile.lastName).catch(() => {});
        }
        if (candidateProfile.email) {
            await page.locator('input[id*="email"], input[name*="email"]').first().fill(candidateProfile.email).catch(() => {});
        }
        if (candidateProfile.phone) {
            await page.locator('input[id*="phone"], input[name*="phone-number"]').first().fill(candidateProfile.phone).catch(() => {});
        }

        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            logger.warn(`[SmartRecruitersAdapter] Required questions missing resolution (${analysis.unresolvedRequired.length} fields).`);
            return { success: false, status: "WAITING_FOR_INPUT", unresolvedRequired: analysis.unresolvedRequired };
        }

        for (const item of analysis.answers) {
            if (item.element && item.value) {
                const sel = item.element.id ? `#${item.element.id}` : `[name="${item.element.name}"]`;
                try {
                    const loc = page.locator(sel).first();
                    if (await loc.count().catch(() => 0) > 0) {
                        const currentVal = await loc.inputValue().catch(() => "");
                        if (!currentVal) {
                            await loc.fill(String(item.value)).catch(() => {});
                        }
                    }
                } catch (e) {}
            }
        }

        return { success: true };
    }

    async submit(page) {
        logger.info("[SmartRecruitersAdapter] Submitting SmartRecruiters application...");
        const submitBtnLocators = [
            page.locator('button#footer-submit'),
            page.locator('button[type="submit"]:has-text("Submit")'),
            page.locator('button:has-text("Submit application")')
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

module.exports = new SmartRecruitersAdapter();
