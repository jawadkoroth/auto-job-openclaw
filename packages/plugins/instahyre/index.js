const BasePlugin = require("../BasePlugin");

class InstahyrePlugin extends BasePlugin {
    async login() {
        this.logger.info("Instahyre login skeleton called.", { plugin: this.name, action: "login" });
        return true;
    }

    async updateProfile() {
        this.logger.info("Instahyre profile update skeleton called.", { plugin: this.name, action: "update_profile" });
        return true;
    }

    async search(queryOptions) {
        this.logger.info(`Instahyre search skeleton called.`, { plugin: this.name, action: "search" });
        return [];
    }

    async apply(jobs, options) {
        this.logger.info(`Instahyre apply skeleton called.`, { plugin: this.name, action: "apply" });
        return 0;
    }
}

module.exports = InstahyrePlugin;
