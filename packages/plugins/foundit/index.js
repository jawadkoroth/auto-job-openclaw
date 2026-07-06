const BasePlugin = require("../BasePlugin");

class FounditPlugin extends BasePlugin {
    async login(page) {
        this.logger.info("Foundit login skeleton called.");
        return true;
    }

    async logout(page) {
        this.logger.info("Foundit logout skeleton called.");
        return true;
    }

    async updateProfile(page) {
        this.logger.info("Foundit profile update skeleton called.");
        return true;
    }

    async search(page, queryOptions) {
        this.logger.info(`Foundit search skeleton query: ${JSON.stringify(queryOptions)}`);
        return [];
    }

    async apply(page, job) {
        this.logger.info(`Foundit apply skeleton called for job_id: ${job.job_id}`);
        return true;
    }

    async health(page) {
        return true;
    }
}

module.exports = FounditPlugin;
