const BrowserInstance = require("./BrowserInstance");
const logger = require("../logger");

class BrowserPool {
    constructor() {
        this.instances = new Map();
    }

    /**
     * Retrieve or instantiate a portal's BrowserInstance
     * @param {string} portalName 
     * @returns {Promise<BrowserInstance>}
     */
    async getInstance(portalName) {
        const key = portalName.toLowerCase();
        if (!this.instances.has(key)) {
            const instance = new BrowserInstance(key);
            this.instances.set(key, instance);
        }
        const instance = this.instances.get(key);
        await instance.launch();
        return instance;
    }

    /**
     * Terminate and remove a specific portal's BrowserInstance
     * @param {string} portalName 
     */
    async closeInstance(portalName) {
        const key = portalName.toLowerCase();
        if (this.instances.has(key)) {
            const instance = this.instances.get(key);
            await instance.close();
            this.instances.delete(key);
        }
    }

    /**
     * Gracefully terminate all active pool browser instances
     */
    async closeAll() {
        logger.browser.info("Terminating all active pool BrowserInstances...");
        for (const [key, instance] of this.instances.entries()) {
            await instance.close();
        }
        this.instances.clear();
    }

    /**
     * Fetch the health status of all currently active pool browsers
     * @returns {Promise<Object>} Map of portal keys to status
     */
    async healthCheckAll() {
        const healthMap = {};
        for (const [key, instance] of this.instances.entries()) {
            healthMap[key] = await instance.healthCheck() ? "healthy" : "unhealthy";
        }
        return healthMap;
    }
}

module.exports = new BrowserPool();
