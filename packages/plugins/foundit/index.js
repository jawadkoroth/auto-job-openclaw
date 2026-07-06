const BasePlugin = require("../BasePlugin");

class FounditPlugin extends BasePlugin {
    async login() {
        this.logger.info("Foundit login skeleton called.", { plugin: this.name, action: "login" });
        return true;
    }

    async updateProfile() {
        this.logger.info("Foundit profile update skeleton called.", { plugin: this.name, action: "update_profile" });
        return true;
    }

    async search(queryOptions) {
        this.logger.info(`Foundit search skeleton called for query: ${JSON.stringify(queryOptions)}`, { plugin: this.name, action: "search" });
        return [];
    }

    async apply(jobs, options) {
        this.logger.info(`Foundit apply skeleton called.`, { plugin: this.name, action: "apply" });
        return 0;
    }
}

module.exports = FounditPlugin;
