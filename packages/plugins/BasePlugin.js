/**
 * BasePlugin Interface
 */
class BasePlugin {
    /**
     * @param {Object} context
     * @param {Object} context.browserManager
     * @param {Object} context.logger
     * @param {Object} context.config
     * @param {string} context.name
     */
    constructor(context) {
        if (!context) {
            throw new Error("Plugin context must be provided.");
        }
        this.browserManager = context.browserManager;
        this.logger = context.logger;
        this.config = context.config;
        this.name = context.name || this.constructor.name.replace("Plugin", "").toLowerCase();
    }

    /**
     * Log in to the job portal
     * @returns {Promise<boolean>}
     */
    async login() {
        throw new Error(`login() not implemented in ${this.constructor.name}`);
    }

    /**
     * Update profile details on the job portal
     * @returns {Promise<boolean>}
     */
    async updateProfile() {
        throw new Error(`updateProfile() not implemented in ${this.constructor.name}`);
    }

    /**
     * Search for jobs matching query/keywords
     * @param {Object} queryOptions 
     * @returns {Promise<any[]>} List of jobs found
     */
    async search(queryOptions) {
        throw new Error(`search() not implemented in ${this.constructor.name}`);
    }

    /**
     * Apply to jobs
     * @param {any[]} jobs
     * @param {Object} options
     * @returns {Promise<number>} Number of jobs successfully applied to
     */
    async apply(jobs, options) {
        throw new Error(`apply() not implemented in ${this.constructor.name}`);
    }
}

module.exports = BasePlugin;
