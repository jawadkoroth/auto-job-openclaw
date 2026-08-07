const BasePlugin = require("../BasePlugin");
const LinkedInSessionBootstrap = require("./LinkedInSessionBootstrap");
const LinkedInConcurrencyLock = require("./LinkedInConcurrencyLock");
const LinkedInDiscovery = require("./LinkedInDiscovery");
const LinkedInApplyEngine = require("./LinkedInApplyEngine");
const LinkedInVerification = require("./LinkedInVerification");
const linkedinPersistence = require("./LinkedInPersistence");

class LinkedInPlugin extends BasePlugin {
    async login(page) {
        this.logger.info("LinkedIn login via storageState session bootstrap.");
        return true;
    }

    async search(page, queryOptions) {
        return LinkedInDiscovery.discoverJobs(page, queryOptions);
    }

    async apply(page, job, options = {}) {
        return LinkedInApplyEngine.applyJob(page, job, options);
    }

    async verify(page, job) {
        return LinkedInVerification.verifyApplication(page, job);
    }

    async health(page) {
        return true;
    }
}

const pluginInstance = new LinkedInPlugin();
pluginInstance.LinkedInSessionBootstrap = LinkedInSessionBootstrap;
pluginInstance.LinkedInConcurrencyLock = LinkedInConcurrencyLock;
pluginInstance.LinkedInDiscovery = LinkedInDiscovery;
pluginInstance.LinkedInApplyEngine = LinkedInApplyEngine;
pluginInstance.LinkedInVerification = LinkedInVerification;
pluginInstance.persistence = linkedinPersistence;

module.exports = pluginInstance;

