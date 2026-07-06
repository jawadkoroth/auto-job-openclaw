const path = require("path");
const fs = require("fs-extra");
const logger = require("../logger");

class SessionManager {
    constructor() {
        this.baseDir = path.join(process.cwd(), "sessions");
        fs.ensureDirSync(this.baseDir);
    }

    /**
     * Get the absolute path to a portal's persistent session profile directory
     * @param {string} portalName 
     * @returns {string}
     */
    getSessionPath(portalName) {
        if (!portalName) {
            throw new Error("Portal name must be provided to get session path.");
        }
        return path.join(this.baseDir, portalName.toLowerCase());
    }

    /**
     * Check if a session exists for the portal
     * @param {string} portalName 
     * @returns {boolean}
     */
    sessionExists(portalName) {
        const sessionPath = this.getSessionPath(portalName);
        if (!fs.existsSync(sessionPath)) return false;
        try {
            const files = fs.readdirSync(sessionPath);
            return files.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Clear (delete) a portal's session profile
     * @param {string} portalName 
     */
    async clearSession(portalName) {
        const sessionPath = this.getSessionPath(portalName);
        if (fs.existsSync(sessionPath)) {
            logger.info(`Clearing session directory for portal: ${portalName}`, { plugin: portalName, action: "clear_session" });
            await fs.remove(sessionPath);
        }
    }

    /**
     * List all active session profiles
     * @returns {Promise<string[]>}
     */
    async listSessions() {
        if (!fs.existsSync(this.baseDir)) return [];
        const files = await fs.readdir(this.baseDir);
        const sessions = [];
        for (const file of files) {
            const fullPath = path.join(this.baseDir, file);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                sessions.push(file);
            }
        }
        return sessions;
    }
}

module.exports = new SessionManager();
