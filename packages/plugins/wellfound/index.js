const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class WellfoundPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        this.logger.info("Wellfound logout initiated.");
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
            const currentUrl = page.url();
            if (!currentUrl.includes("wellfound.com/jobs") && !currentUrl.includes("wellfound.com/profile") && !currentUrl.includes("wellfound.com/applications")) {
                await page.goto("https://wellfound.com/jobs", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            }
            await page.waitForTimeout(2000);
            
            // Check for negative indicator: if Log In button is visible, we are definitely NOT logged in
            const loginBtnCount = await page.locator("a:has-text('Log In'), button:has-text('Log In'), a[href*='/login']").filter({ visible: true }).count();
            if (loginBtnCount > 0) {
                return false;
            }
            
            // Check for positive indicators
            const count = await page.locator("a[href*='/profile/edit'], a:has-text('Profile'), a:has-text('Logout'), a[href*='/messages'], a[href*='/applications'], img[alt*='avatar'], button[id*='user-menu']").count();
            return count > 0;
        } catch (e) {
            return false;
        }
    }
}

module.exports = WellfoundPlugin;
