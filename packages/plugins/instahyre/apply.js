const resumeManager = require("../../resume/ResumeManager");

module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for Instahyre job: "${job.title}" at "${job.company}"`);

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

    const applyBtnSelector = "button:has-text('Apply'), button:has-text('Interested'), #apply-button, button.btn-apply";
    const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;

    if (hasApplyBtn) {
        logger.info("Clicking the Instahyre Apply/Interested button...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(3000);

        const popupSelector = ".modal-dialog, .chatbot-container, :has-text('Submit answers'), :has-text('recruiter\\'s questions')";
        if (await page.locator(popupSelector).count() > 0) {
            const chatbotSelector = ".chatbot-container, :has-text('Submit answers'), :has-text('Answer questions')";
            if (await page.locator(chatbotSelector).count() > 0) {
                logger.warn(`Job requires answering a questionnaire. Skipping.`);
                return false;
            }
            const sendBtn = "button:has-text('Send'), button:has-text('Submit'), button:has-text('Continue')";
            if (await page.locator(sendBtn).count() > 0) {
                logger.info("Submitting cover note/popup...");
                await page.click(sendBtn);
                await page.waitForTimeout(3000);
            }
        }

        logger.info(`Successfully applied for job_id: ${job.job_id}`);
        return true;
    } else {
        logger.warn(`No active apply button found for job_id: ${job.job_id}. Skipping.`);
        return false;
    }
};
