const logger = require("../logger");

class ResumeSelector {
    /**
     * Choose appropriate resume variant based on job title/description keywords.
     * Per Task 5 production rule, variant resolution defaults to the Single Active Default CV.
     * @param {string} title 
     * @param {string} description 
     * @returns {string} Always returns 'default' for single default CV enforcement
     */
    selectResume(title = "", description = "") {
        logger.worker.info(`Selected single default production resume for job: "${title}"`);
        return "default";
    }
}

module.exports = new ResumeSelector();
