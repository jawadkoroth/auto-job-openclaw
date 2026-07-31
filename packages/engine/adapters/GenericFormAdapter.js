const BaseATSAdapter = require("./BaseATSAdapter");
const logger = require("../../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GenericFormAdapter extends BaseATSAdapter {
    constructor() {
        super("GENERIC_FORM");
    }

    async fillForm(page, candidateProfile, questionnaireEngine) {
        logger.info("[GenericFormAdapter] Analyzing generic external application form...");

        const analysis = await questionnaireEngine.analyzePageForm(page, candidateProfile);

        if (!analysis.isSafeToSubmit) {
            logger.warn(`[GenericFormAdapter] Missing answers for ${analysis.unresolvedRequired.length} required field(s).`);
            return {
                success: false,
                status: "WAITING_FOR_INPUT",
                unresolvedRequired: analysis.unresolvedRequired
            };
        }

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

        return { success: true };
    }

    async submit(page) {
        logger.info("[GenericFormAdapter] Submitting generic form...");
        const submitBtnLocators = [
            page.locator('button[type="submit"]'),
            page.locator('input[type="submit"]'),
            page.locator('button:has-text("Submit Application")'),
            page.locator('button:has-text("Submit")'),
            page.locator('button:has-text("Apply")')
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
