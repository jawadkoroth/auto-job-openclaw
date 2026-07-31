const externalSessionManager = require("./ExternalSessionManager");
const logger = require("../../logger").plugin("naukri");

class WorkdaySessionManager {
    /**
     * Derive a tenant key string from a Workday URL or hostname
     * @param {string} urlStr 
     * @returns {string} e.g. "thermofisher_wd5" or "cisco_wd5"
     */
    getTenantKey(urlStr = "") {
        try {
            const host = new URL(urlStr).hostname.toLowerCase();
            const match = host.match(/^([a-z0-9-]+)\.([a-z0-9]+)\.myworkdayjobs\.com$/);
            if (match) {
                return `${match[1]}_${match[2]}`.replace(/[^a-z0-9_-]/g, "_");
            }
            return host.replace(/[^a-z0-9_-]/g, "_");
        } catch (e) {
            return "workday_default";
        }
    }

    /**
     * Check if a valid stored session exists for specified Workday target URL
     */
    hasValidSession(targetUrl) {
        const tenantKey = this.getTenantKey(targetUrl);
        return externalSessionManager.hasSession("workday", tenantKey);
    }

    /**
     * Get Playwright storageState file path for Workday target URL
     */
    getStorageStatePath(targetUrl) {
        const tenantKey = this.getTenantKey(targetUrl);
        return externalSessionManager.getStorageStatePath("workday", tenantKey);
    }

    /**
     * Validate whether page currently displays an authenticated Workday candidate state
     * @param {import('playwright').Page} page 
     * @returns {Promise<{ status: string, authenticated: boolean, candidateEmail?: string, details?: string }>}
     */
    async validateSession(page) {
        try {
            const state = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : "";
                const html = document.documentElement ? document.documentElement.innerHTML.toLowerCase() : "";

                const hasSignIn = text.includes("sign in") || text.includes("create account") || text.includes("autofill with resume");
                const hasSignOut = text.includes("sign out") || text.includes("log out") || text.includes("my account") || text.includes("my applications");
                const hasCandidateAccount = !!document.querySelector('[data-automation-id="candidateAccount"], [data-automation-id="userMenu"]');

                const passwordInput = document.querySelector('input[type="password"]');

                // Extract potential email from UI
                const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);

                return {
                    hasSignIn,
                    hasSignOut,
                    hasCandidateAccount,
                    hasPasswordInput: !!passwordInput,
                    detectedEmail: emailMatch ? emailMatch[0] : null
                };
            }).catch(() => null);

            if (!state) {
                return { status: "UNKNOWN_AUTH_STATE", authenticated: false, details: "Unable to evaluate Workday DOM" };
            }

            if (state.hasSignOut || state.hasCandidateAccount) {
                return {
                    status: "AUTHENTICATED",
                    authenticated: true,
                    candidateEmail: state.detectedEmail,
                    details: "Authenticated candidate session verified via DOM"
                };
            }

            if (state.hasSignIn || state.hasPasswordInput) {
                return {
                    status: "AUTH_REQUIRED",
                    authenticated: false,
                    details: "Workday sign-in prompt active. Stored session expired or unauthenticated."
                };
            }

            return { status: "UNKNOWN_AUTH_STATE", authenticated: false, details: "Ambiguous Workday authentication state" };
        } catch (err) {
            logger.warn(`Workday session validation error: ${err.message}`);
            return { status: "UNKNOWN_AUTH_STATE", authenticated: false, details: err.message };
        }
    }
}

module.exports = new WorkdaySessionManager();
