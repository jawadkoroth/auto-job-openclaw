/**
 * BasePlugin Interface for business logic automation
 */
class BasePlugin {
    /**
     * @param {Object} context
     * @param {Object} context.logger Portal specific logging channel
     * @param {Object} context.config Application configurations
     * @param {string} context.name Plugin lowercase identifier
     */
    constructor(context) {
        if (!context) {
            throw new Error("Plugin context must be provided.");
        }
        this.logger = context.logger;
        this.config = context.config;
        this.name = context.name || this.constructor.name.replace("Plugin", "").toLowerCase();
    }

    /**
     * Log in to the job portal
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>}
     */
    async login(page) {
        throw new Error(`login() not implemented in ${this.constructor.name}`);
    }

    /**
     * Log out from the job portal
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>}
     */
    async logout(page) {
        throw new Error(`logout() not implemented in ${this.constructor.name}`);
    }

    /**
     * Update profile details on the job portal
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>}
     */
    async updateProfile(page) {
        throw new Error(`updateProfile() not implemented in ${this.constructor.name}`);
    }

    /**
     * Search for jobs matching keywords/location query
     * @param {import("playwright").Page} page 
     * @param {Object} queryOptions 
     * @returns {Promise<any[]>} List of normalized jobs
     */
    async search(page, queryOptions) {
        throw new Error(`search() not implemented in ${this.constructor.name}`);
    }

    /**
     * Apply to a specific job listing
     * @param {import("playwright").Page} page 
     * @param {Object} job Job model row from database
     * @returns {Promise<boolean>} Success status
     */
    async apply(page, job) {
        throw new Error(`apply() not implemented in ${this.constructor.name}`);
    }

    /**
     * Assess active session validity
     * @param {import("playwright").Page} page 
     * @returns {Promise<boolean>} True if logged in, false otherwise
     */
    async health(page) {
        throw new Error(`health() not implemented in ${this.constructor.name}`);
    }
}

module.exports = BasePlugin;
