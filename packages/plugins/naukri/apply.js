const resumeManager = require("../../resume/ResumeManager");

/**
 * Naukri Apply Automation script for a single job
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 * @param {Object} job Job model row from database
 */
module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Applying to job: "${job.title}" at "${job.company}"`);
    
    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const applyBtnSelector = "button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')";
    const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied')";
    
    if (await page.locator(alreadyAppliedSelector).count() > 0) {
        logger.info(`Already applied status confirmed for job_id: ${job.job_id}`);
        return true;
    }
    
    if (await page.locator(applyBtnSelector).count() > 0) {
        // Dynamic file input checking for job application forms
        const fileInputSelector = "input[type='file'][name*='resume'], input[type='file'][id*='resume'], input[type='file']";
        
        if (await page.locator(fileInputSelector).count() > 0) {
            try {
                // Fetch resume file path matching current designation profile
                const resumePath = await resumeManager.getResumePath(plugin.name);
                logger.info(`Uploading resume file: ${resumePath}`);
                await page.setInputFiles(fileInputSelector, resumePath);
            } catch (resumeErr) {
                logger.warn(`Could not complete resume attachment step: ${resumeErr.message}`);
            }
        }
        
        await page.click(applyBtnSelector);
        await page.waitForTimeout(3000); 
        logger.info(`Application click event completed for job_id: ${job.job_id}`);
        return true;
    } else {
        logger.warn(`Apply button not visible for job_id: ${job.job_id}`);
        return false;
    }
};
