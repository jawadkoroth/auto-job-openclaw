const fs = require("fs");
const path = require("path");
const logger = require("../../logger").plugin("naukri");

class ExternalSessionManager {
    constructor(baseDir = path.join(process.cwd(), "sessions", "external")) {
        this.baseDir = baseDir;
        this.ensureDirectory(this.baseDir);
    }

    ensureDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Get path to session folder for ATS and tenant key
     * @param {string} ats e.g. "workday"
     * @param {string} tenantKey e.g. "thermofisher_wd5"
     */
    getSessionDir(ats, tenantKey) {
        const cleanAts = String(ats).toLowerCase().trim();
        const cleanTenant = String(tenantKey).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const dir = path.join(this.baseDir, cleanAts, cleanTenant);
        this.ensureDirectory(dir);
        return dir;
    }

    /**
     * Get storageState.json path for specified ATS and tenant key
     */
    getStorageStatePath(ats, tenantKey) {
        return path.join(this.getSessionDir(ats, tenantKey), "storageState.json");
    }

    /**
     * Get metadata.json path for specified ATS and tenant key
     */
    getMetadataPath(ats, tenantKey) {
        return path.join(this.getSessionDir(ats, tenantKey), "metadata.json");
    }

    /**
     * Check if a storageState file exists and is non-empty
     */
    hasSession(ats, tenantKey) {
        const filePath = this.getStorageStatePath(ats, tenantKey);
        if (!fs.existsSync(filePath)) return false;
        try {
            const stat = fs.statSync(filePath);
            return stat.size > 50;
        } catch (e) {
            return false;
        }
    }

    /**
     * Save Playwright storageState and metadata for tenant
     */
    async saveSession({ ats, tenantKey, context, candidateEmail = null, careerHost = "" }) {
        try {
            const storagePath = this.getStorageStatePath(ats, tenantKey);
            await context.storageState({ path: storagePath });

            const metadata = {
                ats: String(ats).toUpperCase(),
                tenantKey,
                careerHost,
                candidateEmail,
                createdAt: new Date().toISOString(),
                lastValidatedAt: new Date().toISOString(),
                status: "AUTHENTICATED"
            };

            const metaPath = this.getMetadataPath(ats, tenantKey);
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf8");
            logger.info(`✓ External Session Saved: ATS=${ats}, Tenant=${tenantKey} -> ${storagePath}`);
            return true;
        } catch (err) {
            logger.error(`❌ Failed to save external session: ${err.message}`);
            return false;
        }
    }

    /**
     * Read metadata for tenant if available
     */
    getMetadata(ats, tenantKey) {
        const metaPath = this.getMetadataPath(ats, tenantKey);
        if (!fs.existsSync(metaPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch (e) {
            return null;
        }
    }
}

module.exports = new ExternalSessionManager();
