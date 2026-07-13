const resumeManager = require("../../resume/ResumeManager");

module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for Wellfound job: "${job.title}" at "${job.company}"`);

    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied')";
    if (await page.locator(alreadyAppliedSelector).count() > 0) {
        logger.info(`Already applied status confirmed for job_id: ${job.job_id}`);
        return true;
    }

    const externalApplySelector = "a:has-text('Apply on company website'), button:has-text('Apply on company website')";
    if (await page.locator(externalApplySelector).count() > 0) {
        logger.warn(`External website redirection required. Skipping.`);
        return false;
    }

    const applyBtnSelector = "button:has-text('Apply'), button.apply-btn, #apply-button, button:has-text('Easy Apply'), button:has-text('Apply Now')";
    const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;

    if (hasApplyBtn) {
        logger.info("Clicking the Wellfound Apply button...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(3000);

        const chatbotSelector = ".chatbot-container, :has-text('Submit answers'), :has-text('Answer questions')";
        if (await page.locator(chatbotSelector).count() > 0) {
            logger.warn(`Job requires answering a questionnaire. Skipping.`);
            return false;
        }

        logger.info(`Successfully applied for job_id: ${job.job_id}`);
        return true;
    } else {
        logger.warn(`No standard apply buttons found for job_id: ${job.job_id}. Skipping.`);
        return false;
    }
};
