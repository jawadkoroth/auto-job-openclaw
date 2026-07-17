const resumeManager = require("../../resume/ResumeManager");

module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for Foundit job: "${job.title}" at "${job.company}"`);

    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied')";
    if (await page.locator(alreadyAppliedSelector).count() > 0) {
        logger.info(`Already applied status confirmed for job_id: ${job.job_id}`);
        job.statusReason = "alreadyApplied";
        return true;
    }

    const externalApplySelector = "a:has-text('Apply on company website'), button:has-text('Apply on company website')";
    if (await page.locator(externalApplySelector).count() > 0) {
        logger.warn(`External website redirection required. Skipping.`);
        job.statusReason = "external";
        return false;
    }

    const applyBtnSelector = "button:has-text('Apply'), button.apply-btn, #apply-button, button:has-text('Easy Apply')";
    const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;

    // Scrape description
    const descSelector = ".job-desc, #job-details, .job-description, #job-description, .description";
    const descText = await page.locator(descSelector).first().innerText().catch(() => "");
    if (descText) {
        job.job_description = descText;
        const db = require("../../database");
        await db.run("UPDATE jobs SET job_description = ? WHERE id = ?", [descText, job.id]).catch(() => {});
    }

    if (hasApplyBtn) {
        const config = require("../../config");
        const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
        if (isDryRun) {
            logger.info(`[DRY RUN] Would apply to: "${job.title}" at "${job.company}"`);
            job.statusReason = "dry_run_validated";
            return true;
        }

        logger.info("Clicking the Foundit Apply button...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(4000);

        const chatbotSelector = ".chatbot-container, :has-text('Submit answers'), :has-text('Answer questions'), :has-text('recruiter\\'s questions')";
        if (await page.locator(chatbotSelector).count() > 0) {
            const questionText = await page.locator(chatbotSelector).first().innerText().catch(() => "Chatbot questions");
            const ApplicationQuestionEngine = require("../../ai/ApplicationQuestionEngine");
            const ansResult = await ApplicationQuestionEngine.answerQuestion({
                question: questionText,
                jobId: job.id,
                jobDescription: descText,
                resumeText: ""
            });
            
            if (ansResult.status === "ANSWERED") {
                logger.info(`Answering chatbot: "${ansResult.answer}"`);
                const inputSelector = "textarea, input[type='text']";
                if (await page.locator(inputSelector).count() > 0) {
                    await page.locator(inputSelector).first().fill(ansResult.answer);
                    await page.waitForTimeout(1000);
                    const sendBtn = "button:has-text('Submit'), button:has-text('Send'), button:has-text('Continue')";
                    if (await page.locator(sendBtn).count() > 0) {
                        await page.click(sendBtn);
                        await page.waitForTimeout(3000);
                    }
                }
            } else {
                logger.warn(`Job requires manual questionnaire answering. Skipping for now.`);
                const db = require("../../database");
                await db.run(
                    "UPDATE jobs SET status = 'WAITING_FOR_INPUT', pending_question = ?, pending_suggested_answer = ? WHERE id = ?",
                    [questionText, ansResult.answer || "Yes", job.id]
                ).catch(() => {});
                
                const telegramService = require("../../../apps/telegram");
                await telegramService.sendMessage(
                    `⚠️ *Application Needs Input*\n\n` +
                    `• *Portal*: \`Foundit\`\n` +
                    `• *Company*: *${job.company}*\n` +
                    `• *Role*: *${job.title}*\n\n` +
                    `❓ *Question*:\n_${questionText}_\n\n` +
                    `💡 *Suggested Answer*:\n_${ansResult.answer || "Yes"}_\n\n` +
                    `🔗 *Job URL*: ${job.url}\n\n` +
                    `To approve: \`/approve ${job.id}\`\n` +
                    `To custom approve: \`/approve ${job.id} <your answer>\``
                ).catch(() => {});
                
                job.statusReason = "questionnaire";
                return false;
            }
        }

        // Verify successful application
        const successConfirmSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied'), :has-text('Applied successfully'), :has-text('Application Submitted')";
        const isConfirmed = await page.locator(successConfirmSelector).count() > 0;
        if (isConfirmed) {
            logger.info(`Successfully applied and verified for job_id: ${job.job_id}`);
            job.statusReason = "applied";
            return true;
        } else {
            logger.warn(`Click action performed but application confirmation not detected on Foundit. Marking as CLICKED_UNVERIFIED.`);
            job.statusReason = "clicked_unverified";
            return true;
        }
    } else {
        logger.warn(`No standard apply buttons found for job_id: ${job.job_id}. Skipping.`);
        job.statusReason = "external";
        return false;
    }
};
