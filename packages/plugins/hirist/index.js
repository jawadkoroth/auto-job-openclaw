const BasePlugin = require("../BasePlugin");

class HiristPlugin extends BasePlugin {
    async login() {
        this.logger.info("Hirist login skeleton called.", { plugin: this.name, action: "login" });
        return true;
    }

    async updateProfile() {
        this.logger.info("Hirist profile update skeleton called.", { plugin: this.name, action: "update_profile" });
        return true;
    }

    async search(queryOptions) {
        this.logger.info(`Hirist search skeleton called.`, { plugin: this.name, action: "search" });
        return [];
    }

    async apply(jobs, options) {
        this.logger.info(`Hirist apply skeleton called.`, { plugin: this.name, action: "apply" });
        return 0;
    }
}

module.exports = HiristPlugin;
