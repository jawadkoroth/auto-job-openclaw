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
            const currentUrl = page.url();
            if (!currentUrl.includes("hirist.tech/profile.html")) {
                await page.goto("https://www.hirist.tech/profile.html", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            }
            
            // Wait up to 10 seconds for either the profile form or the login indicator to render
            const indicator = page.locator("input[type='file'], p.login, p:has-text('Login'), button:has-text('Login'), a:has-text('Login')").first();
            await indicator.waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
            
            const loggedInCount = await page.locator("input[type='file'], a:has-text('Logout'), a[href*='logout']").count();
            return loggedInCount > 0;
        } catch (e) {
            return false;
        }
    }
}

module.exports = HiristPlugin;
