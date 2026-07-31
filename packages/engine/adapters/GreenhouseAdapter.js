const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GreenhouseAdapter extends BaseATSAdapter {
    constructor() {
        super("GREENHOUSE");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[GreenhouseAdapter] Filling Greenhouse job application form...");

        // Fill standard Greenhouse fields if empty
        if (candidateProfile.firstName) {
            await page.locator('#first_name').first().fill(candidateProfile.firstName).catch(() => {});
        }
        if (candidateProfile.lastName) {
            await page.locator('#last_name').first().fill(candidateProfile.lastName).catch(() => {});
        }
        if (candidateProfile.email) {
            await page.locator('#email').first().fill(candidateProfile.email).catch(() => {});
        }
        if (candidateProfile.phone) {
            await page.locator('#phone').first().fill(candidateProfile.phone).catch(() => {});
        }
        if (candidateProfile.linkedinUrl) {
            await page.locator('input[name*="linkedin"], input[id*="linkedin"]').first().fill(candidateProfile.linkedinUrl).catch(() => {});
        }

        // Analyze and fill additional/custom questions
        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);
        if (!analysis.isSafeToSubmit) {
            logger.warn(`[GreenhouseAdapter] Required questions missing resolution (${analysis.unresolvedRequired.length} fields).`);
            return { success: false, status: "WAITING_FOR_INPUT", unresolvedRequired: analysis.unresolvedRequired };
        }

        // Fill answers
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

        return { success: true };
    }

    async submit(page) {
        logger.info("[GreenhouseAdapter] Submitting Greenhouse application...");
        const submitBtnLocators = [
            page.locator('#submit_app'),
            page.locator('input[type="submit"][value*="Submit"]'),
            page.locator('button[type="submit"]:has-text("Submit")'),
            page.locator('button:has-text("Submit Application")')
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

module.exports = new GreenhouseAdapter();
