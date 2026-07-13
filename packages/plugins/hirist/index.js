const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class HiristPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        this.logger.info("Hirist logout initiated.");
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
            await page.waitForTimeout(2000);
            const count = await page.locator("a[href*='/profile.html'], a:has-text('Profile'), a:has-text('Logout'), .profile-img").count();
            return count > 0;
        } catch (e) {
            return false;
        }
    }
}

module.exports = HiristPlugin;
