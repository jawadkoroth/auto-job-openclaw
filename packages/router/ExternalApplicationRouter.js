const db = require("../database");
const logger = require("../logger");

class ExternalApplicationRouter {
    /**
     * Classify the external URL into known ATS categories
     * @param {string} url 
     * @returns {string} One of: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Generic ATS, Unknown
     */
    classifyATS(url) {
        if (!url) return "Unknown";
        const lowercaseUrl = url.toLowerCase();
        
        if (lowercaseUrl.includes("greenhouse.io") || lowercaseUrl.includes("boards.greenhouse.io")) {
            return "Greenhouse";
        }
        if (lowercaseUrl.includes("lever.co")) {
            return "Lever";
        }
        if (lowercaseUrl.includes("myworkdayjobs.com") || lowercaseUrl.includes("workday")) {
            return "Workday";
        }
        if (lowercaseUrl.includes("ashbyhq.com")) {
            return "Ashby";
        }
        if (lowercaseUrl.includes("smartrecruiters.com")) {
            return "SmartRecruiters";
        }
        
        // Other common ATS platforms
        if (
            lowercaseUrl.includes("recruitee.com") || 
            lowercaseUrl.includes("bamboohr.com") || 
            lowercaseUrl.includes("breezy.hr") || 
            lowercaseUrl.includes("lever") || 
            lowercaseUrl.includes("greenhouse")
        ) {
            return "Generic ATS";
        }
        
        return "Unknown";
    }

    /**
     * Route an external application, saving details to DB
     * @param {Object} job 
     * @param {string} externalUrl 
     * @returns {Promise<string>} The detected ATS type
     */
    async route(job, externalUrl) {
        const ats = this.classifyATS(externalUrl);
        logger.worker.info(`Detected ATS for external job: ${ats} (URL: ${externalUrl})`);
        
        await db.run(
            `UPDATE jobs 
             SET status = 'EXTERNAL_PENDING', 
                 external_url = ?, 
                 ats = ?, 
                 ignored = 0, 
                 reason = ? 
             WHERE id = ?`,
            [externalUrl, ats, `External ATS: ${ats}`, job.id]
        );
        
        return ats;
    }
}

module.exports = new ExternalApplicationRouter();
