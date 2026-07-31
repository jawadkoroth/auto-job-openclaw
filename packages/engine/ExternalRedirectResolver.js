const logger = require("../logger").plugin("naukri");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ExternalRedirectResolver {
    /**
     * Is hostname a Naukri domain?
     * @param {string} hostname 
     * @returns {boolean}
     */
    isNaukriDomain(hostname = "") {
        const h = String(hostname || "").toLowerCase().trim();
        return h.endsWith("naukri.com") || h.endsWith("naukrigulf.com") || h === "naukri.com";
    }

    /**
     * Resolve external destination URL from a Naukri apply action
     * @param {Object} params
     * @param {import('playwright').Page} params.page Open Naukri job page
     * @param {import('playwright').BrowserContext} params.context Playwright browser context
     * @param {import('playwright').Locator} params.applyBtn Apply action element locator
     * @returns {Promise<{ resolved: boolean, isExternalDomain: boolean, sourceUrl: string, destinationUrl: string, destinationDomain: string, method: string, evidence: string, pageInstance: import('playwright').Page }>}
     */
    async resolveExternalDestination({ page, context, applyBtn }) {
        const sourceUrl = page.url();
        logger.info(`[RedirectResolver] Initiating external redirect trace from source: ${sourceUrl}`);

        let capturedUrl = "";
        let method = "NONE";
        let evidence = "";
        let targetPage = page;
        let isPopupCreated = false;

        // 1. Inspect DOM Attributes on Apply Button/Link
        if (applyBtn) {
            try {
                const domAttrs = await applyBtn.evaluate(el => {
                    const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
                    const target = el.getAttribute('target') || el.closest('a')?.getAttribute('target') || '';
                    const onclick = el.getAttribute('onclick') || '';
                    const dataUrl = el.getAttribute('data-url') || el.getAttribute('data-apply-url') || el.getAttribute('data-external-url') || '';
                    return { href, target, onclick, dataUrl };
                }).catch(() => null);

                if (domAttrs) {
                    if (domAttrs.dataUrl && (domAttrs.dataUrl.startsWith('http://') || domAttrs.dataUrl.startsWith('https://'))) {
                        try {
                            const parsed = new URL(domAttrs.dataUrl);
                            if (!this.isNaukriDomain(parsed.hostname)) {
                                capturedUrl = domAttrs.dataUrl;
                                method = "DOM_HREF";
                                evidence = `data-url attribute: ${domAttrs.dataUrl}`;
                            }
                        } catch (e) {}
                    } else if (domAttrs.href && (domAttrs.href.startsWith('http://') || domAttrs.href.startsWith('https://'))) {
                        try {
                            const parsed = new URL(domAttrs.href);
                            if (!this.isNaukriDomain(parsed.hostname)) {
                                capturedUrl = domAttrs.href;
                                method = "DOM_HREF";
                                evidence = `href attribute: ${domAttrs.href}`;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }

        // 2. Set up Network / Request / Redirect listeners
        let apiRedirectUrl = "";
        const responseListener = (res) => {
            try {
                const status = res.status();
                if ([301, 302, 303, 307, 308].includes(status)) {
                    const locHeader = res.headers()['location'];
                    if (locHeader && (locHeader.startsWith('http://') || locHeader.startsWith('https://'))) {
                        const parsed = new URL(locHeader);
                        if (!this.isNaukriDomain(parsed.hostname)) {
                            apiRedirectUrl = locHeader;
                        }
                    }
                }
            } catch (e) {}
        };

        context.on('response', responseListener);

        // 3. Set up Popup / New Tab Listener
        const popupPromise = context.waitForEvent('page', { timeout: 12000 }).catch(() => null);

        // Perform Click Action
        if (applyBtn) {
            logger.info(`[RedirectResolver] Triggering Apply control click...`);
            await applyBtn.click().catch(() => {});
        }

        const popup = await popupPromise;
        context.off('response', responseListener);

        if (popup) {
            targetPage = popup;
            isPopupCreated = true;
            await targetPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
            method = "POPUP";
            capturedUrl = targetPage.url();
            evidence = `New popup page event opened: ${capturedUrl}`;
        } else {
            await delay(4000);
            const currentUrl = page.url();
            if (currentUrl !== sourceUrl) {
                capturedUrl = currentUrl;
                method = "SAME_TAB_NAVIGATION";
                evidence = `Same-tab navigation settled at: ${currentUrl}`;
            } else if (apiRedirectUrl) {
                capturedUrl = apiRedirectUrl;
                method = "API_RESPONSE";
                evidence = `API HTTP redirect captured: ${apiRedirectUrl}`;
            }
        }

        // 4. Invariant Validation & Hostname Verification
        let destinationDomain = "";
        let isExternalDomain = false;

        if (capturedUrl) {
            try {
                const parsed = new URL(capturedUrl);
                destinationDomain = parsed.hostname;
                isExternalDomain = !this.isNaukriDomain(destinationDomain);
            } catch (e) {
                destinationDomain = capturedUrl;
                isExternalDomain = false;
            }
        }

        logger.info(`[RedirectResolver] Resolution complete:`);
        logger.info(`  • Method:            ${method}`);
        logger.info(`  • Captured URL:      ${capturedUrl || '(None)'}`);
        logger.info(`  • Destination Domain:${destinationDomain || '(None)'}`);
        logger.info(`  • Is External Domain:${isExternalDomain}`);

        return {
            resolved: isExternalDomain && !!capturedUrl,
            isExternalDomain,
            sourceUrl,
            destinationUrl: capturedUrl,
            destinationDomain,
            method,
            evidence,
            pageInstance: targetPage,
            isPopupCreated
        };
    }
}

module.exports = new ExternalRedirectResolver();
