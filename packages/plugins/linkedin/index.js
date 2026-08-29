const BasePlugin = require("../BasePlugin");
const LinkedInSessionBootstrap = require("./LinkedInSessionBootstrap");
const LinkedInConcurrencyLock = require("./LinkedInConcurrencyLock");
const LinkedInDiscovery = require("./LinkedInDiscovery");
const LinkedInApplyEngine = require("./LinkedInApplyEngine");
const LinkedInVerification = require("./LinkedInVerification");
const linkedinPersistence = require("./LinkedInPersistence");

class LinkedInPlugin extends BasePlugin {
    constructor(context = {}) {
        const defaultContext = {
            logger: require("../../logger").plugin("linkedin"),
            config: require("../../config"),
            name: "linkedin"
        };
        super(context && context.logger ? context : defaultContext);
    }

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

LinkedInPlugin.LinkedInSessionBootstrap = LinkedInSessionBootstrap;
LinkedInPlugin.LinkedInConcurrencyLock = LinkedInConcurrencyLock;
LinkedInPlugin.LinkedInDiscovery = LinkedInDiscovery;
LinkedInPlugin.LinkedInApplyEngine = LinkedInApplyEngine;
LinkedInPlugin.LinkedInVerification = LinkedInVerification;
LinkedInPlugin.persistence = linkedinPersistence;

module.exports = LinkedInPlugin;

