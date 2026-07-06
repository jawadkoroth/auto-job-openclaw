const path = require("path");
const fs = require("fs-extra");
const logger = require("../logger");

class ContextManager {
    constructor() {
        this.baseDir = path.join(process.cwd(), "sessions");
        fs.ensureDirSync(this.baseDir);
    }

    /**
     * Resolve the absolute path to a portal session profile
     * @param {string} portalName 
     */
    getContextPath(portalName) {
        const portalDir = path.join(this.baseDir, portalName.toLowerCase());
        fs.ensureDirSync(portalDir);
        return portalDir;
    }

    /**
     * Resolve the metadata path for a portal
     * @param {string} portalName 
     */
    getMetadataPath(portalName) {
        return path.join(this.getContextPath(portalName), "metadata.json");
    }

    /**
     * Get the persistent session metadata for a portal
     * @param {string} portalName 
     */
    async getMetadata(portalName) {
        const metaPath = this.getMetadataPath(portalName);
        if (await fs.pathExists(metaPath)) {
            try {
                return await fs.readJson(metaPath);
            } catch (err) {
                logger.browser.error(`Failed parsing session metadata for ${portalName}: ${err.message}`);
            }
        }
        return {
            lastLogin: null,
            cookieAge: null,
            lastRefresh: null,
            profileUpdated: null,
            resumeUploaded: null,
            browserVersion: null,
            sessionHealth: "unknown"
        };
    }

    /**
     * Write updates to the portal session metadata JSON
     * @param {string} portalName 
     * @param {Object} updates 
     */
    async updateMetadata(portalName, updates) {
        const metaPath = this.getMetadataPath(portalName);
        const current = await this.getMetadata(portalName);
        const updated = { ...current, ...updates };
        await fs.writeJson(metaPath, updated, { spaces: 2 });
        logger.browser.info(`Updated session metadata for portal: ${portalName}`);
    }

    /**
     * Purge directory contents of a session profile to trigger clean logins
     * @param {string} portalName 
     */
    async clearSession(portalName) {
        const contextDir = this.getContextPath(portalName);
        logger.browser.warn(`Clearing active session context for portal: ${portalName}`);
        await fs.remove(contextDir);
        fs.ensureDirSync(contextDir);
    }
}

module.exports = new ContextManager();
