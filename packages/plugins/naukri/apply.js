const resumeManager = require("../../resume/ResumeManager");

/**
 * Naukri Apply Automation script for a single job listing
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 * @param {Object} job Job model row from database
 */
module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for: "${job.title}" at "${job.company}"`);
    
    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    logger.info("Job details page loaded.");

    // Detect if already applied
    const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), div:has-text('Applied')";
    if (await page.locator(alreadyAppliedSelector).count() > 0) {
        logger.info(`Already applied status confirmed for job_id: ${job.job_id}`);
        return true;
    }

    // Detect if this is an external redirect / unsupported application
    const externalApplySelector = "button:has-text('Apply on company website'), a:has-text('Apply on company website'), button:has-text('Apply on company site')";
    if (await page.locator(externalApplySelector).count() > 0) {
        logger.warn(`Unsupported job type (requires third-party site registration) for job_id: ${job.job_id}. Skipping.`);
        // Returning null/false signaling unsupported/skipped
        return false;
    }

    const applyBtnSelector = "button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')";
    const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;
    
    if (hasApplyBtn) {
        // Look for file input to attach resume if required by the page form
        const fileInputSelector = "input[type='file']#attachCV, input[type='file'][name*='resume'], input[type='file']";
        if (await page.locator(fileInputSelector).count() > 0) {
            try {
                const resumePath = await resumeManager.getResumePath(plugin.name);
                logger.info(`Uploading resume: ${resumePath}`);
                await page.setInputFiles(fileInputSelector, resumePath);
            } catch (resumeErr) {
                logger.warn(`Could not attach resume: ${resumeErr.message}`);
            }
        }

        logger.info("Clicking the Apply button...");
        await page.click(applyBtnSelector);
        
        // Wait for page reaction
        await page.waitForTimeout(3000);

        // Check if there is an on-screen questionnaire pop-up (often happens on Naukri)
        // If a pop-up occurs asking questions, we can skip it as unsupported
        const popupSelector = ".chatbot-container, .questionnaire-container, :has-text('Submit answers'), :has-text('Answer questions')";
        if (await page.locator(popupSelector).count() > 0) {
            logger.warn(`Job requires answering a questionnaire for job_id: ${job.job_id}. Skipping.`);
            return false;
        }

        logger.info(`Successfully submitted application for job_id: ${job.job_id}`);
        return true;
    } else {
        logger.warn(`No standard apply buttons found for job_id: ${job.job_id}. Skipping.`);
        return false;
    }
};
