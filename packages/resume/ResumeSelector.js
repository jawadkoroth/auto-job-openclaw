const path = require("path");
const logger = require("../logger");

class ResumeSelector {
    /**
     * Choose appropriate resume variant based on job title/description keywords
     * @param {string} title 
     * @param {string} description 
     * @returns {string} One of: 'devops', 'cloud', 'platform', 'default'
     */
    selectResume(title = "", description = "") {
        const text = `${title} ${description}`.toLowerCase();
        
        let selected = "default";
        if (text.includes("devops") || text.includes("ci/cd") || text.includes("cicd") || text.includes("kubernetes") || text.includes("jenkins") || text.includes("docker")) {
            selected = "devops";
        } else if (text.includes("aws") || text.includes("azure") || text.includes("gcp") || text.includes("cloud")) {
            selected = "cloud";
        } else if (text.includes("platform") || text.includes("infrastructure") || text.includes("terraform")) {
            selected = "platform";
        }
        
        logger.worker.info(`Selected resume variant "${selected}" for job: "${title}"`);
        return selected;
    }
}

module.exports = new ResumeSelector();
