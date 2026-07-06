const BasePlugin = require("../BasePlugin");

class HiristPlugin extends BasePlugin {
    async login(page) {
        this.logger.info("Hirist login skeleton called.");
        return true;
    }

    async logout(page) {
        this.logger.info("Hirist logout skeleton called.");
        return true;
    }

    async updateProfile(page) {
        this.logger.info("Hirist profile update skeleton called.");
        return true;
    }

    async search(page, queryOptions) {
        this.logger.info(`Hirist search skeleton query: ${JSON.stringify(queryOptions)}`);
        return [];
    }

    async apply(page, job) {
        this.logger.info(`Hirist apply skeleton called for job_id: ${job.job_id}`);
        return true;
    }

    async health(page) {
        return true;
    }
}

module.exports = HiristPlugin;
