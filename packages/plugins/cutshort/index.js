const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class CutshortPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        this.logger.info("Cutshort logout initiated.");
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
            const count = await page.locator("a[href*='/user/'], a[href*='/profile'], a:has-text('Logout'), a:has-text('Sign Out'), [class*='profile']").count().catch(() => 0);
            if (count > 0) return true;

            const currentUrl = page.url();
            if (currentUrl.includes("cutshort.io/dashboard") || currentUrl.includes("cutshort.io/user")) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
}

module.exports = CutshortPlugin;
