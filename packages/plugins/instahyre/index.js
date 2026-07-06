const BasePlugin = require("../BasePlugin");

class InstahyrePlugin extends BasePlugin {
    async login(page) {
        this.logger.info("Instahyre login skeleton called.");
        return true;
    }

    async logout(page) {
        this.logger.info("Instahyre logout skeleton called.");
        return true;
    }

    async updateProfile(page) {
        this.logger.info("Instahyre profile update skeleton called.");
        return true;
    }

    async search(page, queryOptions) {
        this.logger.info(`Instahyre search skeleton query: ${JSON.stringify(queryOptions)}`);
        return [];
    }

    async apply(page, job) {
        this.logger.info(`Instahyre apply skeleton called for job_id: ${job.job_id}`);
        return true;
    }

    async health(page) {
        return true;
    }
}

module.exports = InstahyrePlugin;
