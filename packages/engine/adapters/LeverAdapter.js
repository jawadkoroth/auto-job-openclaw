const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LeverAdapter extends BaseATSAdapter {
    constructor() {
        super("LEVER");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[LeverAdapter] Filling Lever job application form...");

        if (candidateProfile.fullName || candidateProfile.firstName) {
            const nameVal = candidateProfile.fullName || `${candidateProfile.firstName || ""} ${candidateProfile.lastName || ""}`.trim();
            await page.locator('input[name="name"]').first().fill(nameVal).catch(() => {});
        }
        if (candidateProfile.email) {
            await page.locator('input[name="email"]').first().fill(candidateProfile.email).catch(() => {});
        }
        if (candidateProfile.phone) {
            await page.locator('input[name="phone"]').first().fill(candidateProfile.phone).catch(() => {});
        }
        if (candidateProfile.currentCompany) {
            await page.locator('input[name="org"]').first().fill(candidateProfile.currentCompany).catch(() => {});
        }
        if (candidateProfile.linkedinUrl) {
            await page.locator('input[name="urls[LinkedIn]"]').first().fill(candidateProfile.linkedinUrl).catch(() => {});
        }
        if (candidateProfile.githubUrl) {
            await page.locator('input[name="urls[GitHub]"]').first().fill(candidateProfile.githubUrl).catch(() => {});
        }

        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            logger.warn(`[LeverAdapter] Required questions missing resolution (${analysis.unresolvedRequired.length} fields).`);
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
        logger.info("[LeverAdapter] Submitting Lever application...");
        const submitBtnLocators = [
            page.locator('#post-submit-btn'),
            page.locator('button[type="submit"]:has-text("Submit application")'),
            page.locator('button[type="submit"]')
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

module.exports = new LeverAdapter();
