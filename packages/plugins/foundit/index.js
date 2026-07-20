const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class FounditPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        this.logger.info("Foundit logout initiated.");
        try {
            await page.click("a:has-text('Logout')").catch(() => {});
        } catch (e) {
            // ignore
        }
        return true;
    }

    async updateProfile(page) {
        return profile(this, page);
    }

    async search(page, queryOptions) {
        return search(this, page, queryOptions);
    }

    async apply(page, job) {
        return apply(this, page, job);
    }

    async health(page) {
        try {
            // Read-only indicator check
            const count = await page.locator("a[href*='/seeker/profile'], a[href*='logout'], a:has-text('Logout'), a:has-text('Sign Out'), .profile-name, .userName, #userNameProfile, div.user-profile-info").count().catch(() => 0);
            if (count > 0) return true;

            // Only navigate to dashboard if NOT in HEADFUL_AUTH_SETUP mode
            if (process.env.HEADFUL_AUTH_SETUP !== "true") {
                const currentUrl = page.url();
                if (!currentUrl.includes("foundit.in/seeker/dashboard") && !currentUrl.includes("foundit.in/seeker/profile")) {
                    await page.goto("https://www.foundit.in/seeker/dashboard", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
                }
                await page.waitForTimeout(2000);
                const finalCount = await page.locator("a[href*='/seeker/profile'], a[href*='logout'], a:has-text('Logout'), a:has-text('Sign Out'), .profile-name, .userName, #userNameProfile").count().catch(() => 0);
                return finalCount > 0;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
}

module.exports = FounditPlugin;
