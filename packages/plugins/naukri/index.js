const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class NaukriPlugin extends BasePlugin {
    /**
     * Authenticate Naukri profile
     */
    async login() {
        return login(this);
    }

    /**
     * Perform profile updates (e.g. updating headline text)
     */
    async updateProfile() {
        return profile(this);
    }

    /**
     * Search for jobs matching keyword/location query
     * @param {Object} queryOptions 
     */
    async search(queryOptions) {
        return search(this, queryOptions);
    }

    /**
     * Apply to a list of jobs
     * @param {any[]} jobs 
     * @param {Object} options 
     */
    async apply(jobs, options) {
        return apply(this, jobs, options);
    }
}

module.exports = NaukriPlugin;
