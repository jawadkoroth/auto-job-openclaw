const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class NaukriPlugin extends BasePlugin {
    /**
     * Authenticate Naukri profile
     * @param {import("playwright").Page} page 
     */
    async login(page) {
        return login(this, page);
    }

    /**
     * Terminate Naukri session
     * @param {import("playwright").Page} page 
     */
    async logout(page) {
        this.logger.info("Naukri logout initiated.");
        // Try clicking logout button if visible
        try {
            await page.click("a:has-text('Logout')").catch(() => {});
        } catch (e) {
            // ignore
        }
        return true;
    }

    /**
     * Perform profile updates (e.g. updating headline text)
     * @param {import("playwright").Page} page 
     */
    async updateProfile(page) {
        return profile(this, page);
    }

    /**
     * Search for jobs matching keyword/location query
     * @param {import("playwright").Page} page 
     * @param {Object} queryOptions 
     */
    async search(page, queryOptions) {
        return search(this, page, queryOptions);
    }

    /**
     * Apply to a specific job listing
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     */
    async apply(page, job) {
        return apply(this, page, job);
    }

    /**
     * Check if Naukri session is authenticated
     * @param {import("playwright").Page} page 
     */
    async health(page) {
        const loggedInSelector = "a[href*='naukri.com/mnj/profile'], .nICM-profile-header, a:has-text('View profile')";
        try {
            return await page.locator(loggedInSelector).count() > 0;
        } catch (e) {
            return false;
        }
    }
}

module.exports = NaukriPlugin;
