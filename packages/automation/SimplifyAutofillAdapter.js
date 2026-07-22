const logger = require("../logger");

class SimplifyAutofillAdapter {
    /**
     * Checks if Simplify Chrome extension is loaded and active on page
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>}
     */
    async isSimplifyAvailable(page) {
        try {
            const simplifyMarkers = page.locator("[id*='simplify'], [class*='simplify'], iframe[src*='simplify']");
            const count = await simplifyMarkers.count().catch(() => 0);
            return count > 0;
        } catch {
            return false;
        }
    }

    /**
     * Attempts Simplify autofill and verifies fields populated
     * @param {import("playwright").Page} page 
     * @returns {Promise<{ simplifyUsed: boolean, fieldsFilled: number }>}
     */
    async fill(page) {
        const result = { simplifyUsed: false, fieldsFilled: 0 };

        try {
            const available = await this.isSimplifyAvailable(page);
            if (!available) {
                logger.worker.info(`[Simplify Adapter] Simplify extension unavailable or unsupported in current environment. Using native autofill fallback.`);
                return result;
            }

            logger.worker.info(`[Simplify Adapter] Simplify extension detected. Triggering autofill...`);
            const simplifyTrigger = page.locator("button:has-text('Autofill with Simplify'), [data-simplify-autofill]").first();

            if (await simplifyTrigger.count() > 0 && await simplifyTrigger.isVisible().catch(() => false)) {
                await simplifyTrigger.click({ force: true }).catch(() => {});
                await page.waitForTimeout(4000);
                result.simplifyUsed = true;
            }

            // Verify populated fields
            const inputs = page.locator("input[type='text'], input[type='email'], input[type='tel'], select");
            const count = await inputs.count().catch(() => 0);
            let filled = 0;

            for (let i = 0; i < count; i++) {
                const val = await inputs.nth(i).inputValue().catch(() => "");
                if (val && val.trim().length > 0) {
                    filled++;
                }
            }

            result.fieldsFilled = filled;
            logger.worker.info(`[Simplify Adapter] Autofill completed. Verified ${filled} populated fields.`);

            return result;
        } catch (err) {
            logger.worker.warn(`[Simplify Adapter] Exception during autofill: ${err.message}. Falling back to native engine.`);
            return result;
        }
    }
}

module.exports = new SimplifyAutofillAdapter();
