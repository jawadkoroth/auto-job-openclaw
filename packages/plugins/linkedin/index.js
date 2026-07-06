const BasePlugin = require("../BasePlugin");

class LinkedInPlugin extends BasePlugin {
    async login(page) {
        this.logger.info("LinkedIn login skeleton called.");
        return true;
    }

    async logout(page) {
        this.logger.info("LinkedIn logout skeleton called.");
        return true;
    }

    async updateProfile(page) {
        this.logger.info("LinkedIn profile update skeleton called.");
        return true;
    }

    async search(page, queryOptions) {
        this.logger.info(`LinkedIn search skeleton query: ${JSON.stringify(queryOptions)}`);
        return [];
    }

    async apply(page, job) {
        this.logger.info(`LinkedIn apply skeleton called for job_id: ${job.job_id}`);
        return true;
    }

    async health(page) {
        return true;
    }
}

module.exports = LinkedInPlugin;
