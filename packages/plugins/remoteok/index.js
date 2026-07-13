const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class RemoteOKPlugin extends BasePlugin {
    async login(page) {
        return login(this, page);
    }

    async logout(page) {
        return true;
    }

    async updateProfile(page) {
        return profile(this, page);
    }

    async search(page, queryOptions) {
        return search(this, page, queryOptions);
    }

    async apply(page, job) {
        return apply(this, page, job);
    }

    async health(page) {
        return true;
    }
}

module.exports = RemoteOKPlugin;
