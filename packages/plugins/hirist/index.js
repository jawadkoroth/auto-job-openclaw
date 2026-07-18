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
            let currentUrl = page.url();
            let isLoggedIn = false;
            
            if (currentUrl.includes("hirist.tech/jobfeed")) {
                isLoggedIn = true;
            } else {
                if (!currentUrl.includes("hirist.tech/profile.html")) {
                    await page.goto("https://www.hirist.tech/profile.html", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
                    currentUrl = page.url();
                }
                
                if (currentUrl.includes("hirist.tech/jobfeed")) {
                    isLoggedIn = true;
                } else {
                    const indicator = page.locator("input[type='file'], p.login, p:has-text('Login'), button:has-text('Login'), a:has-text('Login')").first();
                    await indicator.waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
                    
                    const loggedInCount = await page.locator("input[type='file'], a:has-text('Logout'), a[href*='logout']").count();
                    isLoggedIn = loggedInCount > 0;
                }
            }
            
            const contextManager = require("../../browser/ContextManager");
            const currentMeta = await contextManager.getMetadata(this.name);
            const nextHealth = isLoggedIn ? "healthy" : "auth_required";
            
            if (currentMeta.sessionHealth !== nextHealth) {
                await contextManager.updateMetadata(this.name, { sessionHealth: nextHealth }).catch(() => {});
            }
            return isLoggedIn;
        } catch (e) {
            const contextManager = require("../../browser/ContextManager");
            const currentMeta = await contextManager.getMetadata(this.name).catch(() => ({}));
            if (currentMeta.sessionHealth !== "auth_required") {
                await contextManager.updateMetadata(this.name, { sessionHealth: "auth_required" }).catch(() => {});
            }
            return false;
        }
    }
}

module.exports = HiristPlugin;
