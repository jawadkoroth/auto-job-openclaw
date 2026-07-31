const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AshbyAdapter extends BaseATSAdapter {
    constructor() {
        super("ASHBY");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[AshbyAdapter] Filling Ashby job application form...");

        if (candidateProfile.fullName || candidateProfile.firstName) {
            const nameVal = candidateProfile.fullName || `${candidateProfile.firstName || ""} ${candidateProfile.lastName || ""}`.trim();
            await page.locator('input[name*="name"], input[id*="name"]').first().fill(nameVal).catch(() => {});
        }
        if (candidateProfile.email) {
            await page.locator('input[type="email"], input[name*="email"]').first().fill(candidateProfile.email).catch(() => {});
        }
        if (candidateProfile.phone) {
            await page.locator('input[type="tel"], input[name*="phone"]').first().fill(candidateProfile.phone).catch(() => {});
        }

        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            logger.warn(`[AshbyAdapter] Required questions missing resolution (${analysis.unresolvedRequired.length} fields).`);
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
        logger.info("[AshbyAdapter] Submitting Ashby application...");
        const submitBtn = page.locator('button[type="submit"]:has-text("Submit Application"), button[type="submit"]').first();
        if (await submitBtn.count().catch(() => 0) > 0 && await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click().catch(() => {});
            await delay(3000);
            return true;
        }
        return false;
    }
}

module.exports = new AshbyAdapter();
