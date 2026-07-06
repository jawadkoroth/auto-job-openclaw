const path = require("path");
const fs = require("fs-extra");
const logger = require("../logger");

class ResumeManager {
    constructor() {
        this.resumeDir = path.join(process.cwd(), "resumes");
        this.mappingPath = path.join(this.resumeDir, "mapping.json");
        fs.ensureDirSync(this.resumeDir);
    }

    /**
     * Resolve the absolute path of the resume PDF to upload
     * @param {string} portalName Name of the portal (e.g. 'naukri')
     * @param {string} profileType Designation tag (e.g. 'devops')
     * @returns {Promise<string>} File path to target PDF
     */
    async getResumePath(portalName, profileType = "default") {
        const mappings = await this.getMappings();
        const portalKey = portalName.toLowerCase();
        
        let filename = null;
        if (mappings[portalKey] && mappings[portalKey][profileType]) {
            filename = mappings[portalKey][profileType];
        } else if (mappings[profileType]) {
            filename = mappings[profileType];
        } else if (mappings["default"]) {
            filename = mappings["default"];
        }

        if (!filename) {
            // Find any PDF in resumes folder as fallback
            const files = await fs.readdir(this.resumeDir);
            const pdfs = files.filter(f => f.endsWith(".pdf"));
            if (pdfs.length > 0) {
                logger.worker.warn(`Resume not mapped for ${portalName}. Using fallback: ${pdfs[0]}`);
                return path.join(this.resumeDir, pdfs[0]);
            }
            throw new Error(`No mapped resume config found for ${portalName} (${profileType}) and no fallback files found.`);
        }

        const fullPath = path.join(this.resumeDir, filename);
        if (!await fs.pathExists(fullPath)) {
            // If mapping file is configured but the PDF is missing, look for fallback
            const files = await fs.readdir(this.resumeDir);
            const pdfs = files.filter(f => f.endsWith(".pdf"));
            if (pdfs.length > 0) {
                logger.worker.warn(`Configured file missing: ${filename}. Using fallback: ${pdfs[0]}`);
                return path.join(this.resumeDir, pdfs[0]);
            }
            throw new Error(`Resume file missing at path: ${fullPath}`);
        }
        
        return fullPath;
    }

    /**
     * Fetch the resume mapping structure
     * @returns {Promise<Object>} Mappings schema
     */
    async getMappings() {
        if (await fs.pathExists(this.mappingPath)) {
            try {
                return await fs.readJson(this.mappingPath);
            } catch (e) {
                // fall through
            }
        }
        
        const defaultMappings = {
            "default": "resume.pdf",
            "devops": "devops_resume.pdf",
            "naukri": {
                "devops": "devops_resume.pdf",
                "default": "resume.pdf"
            }
        };
        await fs.writeJson(this.mappingPath, defaultMappings, { spaces: 2 });
        return defaultMappings;
    }
}

module.exports = new ResumeManager();
