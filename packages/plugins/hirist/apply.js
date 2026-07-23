const resumeManager = require("../../resume/ResumeManager");

async function handleHiristCoverLetter(plugin, page, job, descText) {
    const { logger } = plugin;
    
    const checkboxLocators = [
        page.locator("input[type='checkbox']#cover-letter"),
        page.locator("input[type='checkbox'][name*='cover' i]"),
        page.locator("input[type='checkbox'][id*='cover' i]"),
        page.locator("label:has-text('cover letter')").locator("input[type='checkbox']"),
        page.locator("label:has-text('Cover Letter')").locator("input[type='checkbox']"),
        page.locator("label:has-text('Add Cover Letter')").locator("input[type='checkbox']"),
        page.locator("label:has-text('Add Cover Letter')"),
        page.locator("span:has-text('Add Cover Letter')"),
        page.locator("span:has-text('Add cover letter')")
    ];

    let foundCheckbox = null;
    for (const loc of checkboxLocators) {
        if (await loc.count() > 0 && await loc.first().isVisible()) {
            foundCheckbox = loc.first();
            break;
        }
    }

    if (!foundCheckbox) {
        return false;
    }

    logger.info("[hirist] Cover letter option detected.");

    let isChecked = false;
    const tagName = await foundCheckbox.evaluate(el => el.tagName.toLowerCase()).catch(() => "");
    const typeAttr = await foundCheckbox.getAttribute("type").catch(() => "");
    
    if (tagName === "input" && typeAttr === "checkbox") {
        isChecked = await foundCheckbox.isChecked();
        if (!isChecked) {
            await foundCheckbox.check();
            await page.waitForTimeout(1000);
            isChecked = await foundCheckbox.isChecked();
            if (isChecked) {
                logger.info("[hirist] Cover letter enabled.");
            } else {
                await foundCheckbox.click();
                await page.waitForTimeout(1000);
                isChecked = await foundCheckbox.isChecked();
                if (isChecked) {
                    logger.info("[hirist] Cover letter enabled.");
                }
            }
        } else {
            logger.info("[hirist] Cover letter enabled.");
        }
    } else {
        await foundCheckbox.click();
        await page.waitForTimeout(1000);
        logger.info("[hirist] Cover letter enabled.");
    }

    const textareaLocators = [
        page.locator("textarea[name*='cover' i]"),
        page.locator("textarea[id*='cover' i]"),
        page.locator("textarea[placeholder*='cover' i]"),
        page.locator("textarea[placeholder*='Cover' i]"),
        page.locator("textarea")
    ];

    let foundTextarea = null;
    for (const loc of textareaLocators) {
        if (await loc.count() > 0 && await loc.first().isVisible()) {
            foundTextarea = loc.first();
            break;
        }
    }

    if (!foundTextarea) {
        logger.error("[hirist] Cover letter checkbox was checked, but cover letter textarea could not be found.");
        return true;
    }

    // Check if textarea is already filled
    const existingVal = await foundTextarea.inputValue().catch(() => "");
    if (existingVal && existingVal.trim().length > 10) {
        logger.info("[hirist] Cover letter attached/filled successfully.");
        return true;
    }

    let coverLetterText = "";
    try {
        const profileManager = require("../../profile/ProfileManager");
        const profile = await profileManager.getProfile();
        const aiService = require("../../ai");
        
        const systemPrompt = `
You are an expert cover letter writer.
Generate a concise, professional cover letter (1 paragraph, max 100 words) for a DevOps/Cloud/Platform/Infrastructure Engineer role.
Tailor it to the job title and company, using the candidate profile details.
Be concise and focus on cloud automation, CI/CD, and infrastructure-as-code.
Candidate Profile:
${JSON.stringify(profile, null, 2)}
`;
        const prompt = `Write a short cover letter for the role: "${job.title}" at "${job.company}". Job Description: "${descText || ''}"`;
        coverLetterText = await aiService.generateText(prompt, systemPrompt);
        
        if (!coverLetterText || coverLetterText.trim().length === 0) {
            throw new Error("AI generated empty cover letter text.");
        }
    } catch (err) {
        logger.error(`[hirist] AI cover-letter generation failed: ${err.message}. Using safe fallback.`);
        const profileManager = require("../../profile/ProfileManager");
        const profile = await profileManager.getProfile().catch(() => ({ fullName: "Jawad Koroth" }));
        coverLetterText = `Dear Hiring Team,\n\nI am writing to express my strong interest in the ${job.title || 'DevOps/Cloud/Platform Engineer'} position at ${job.company || 'your company'}. With my strong background in automating infrastructure, optimizing CI/CD pipelines, and managing containerized applications on AWS and Kubernetes, I am confident I can contribute effectively to your engineering goals.\n\nSincerely,\n${profile.fullName || 'Jawad Koroth'}`;
    }

    await foundTextarea.fill(coverLetterText);
    await page.waitForTimeout(1000);
    logger.info("[hirist] Cover letter attached/filled successfully.");
    return true;
}

module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for Hirist job: "${job.title}" at "${job.company}"`);

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

        // Attempt cover letter handling before clicking Apply
        let coverLetterHandled = false;
        try {
            coverLetterHandled = await handleHiristCoverLetter(plugin, page, job, descText);
        } catch (coverErr) {
            logger.error(`[hirist] Cover letter handling encountered an error: ${coverErr.message}`);
        }

        logger.info("Clicking the Hirist Apply button...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(4000);

        // Attempt cover letter handling after clicking Apply if not handled before
        if (!coverLetterHandled) {
            try {
                coverLetterHandled = await handleHiristCoverLetter(plugin, page, job, descText);
            } catch (coverErr) {
                logger.error(`[hirist] Cover letter handling encountered an error after click: ${coverErr.message}`);
            }
        }

        if (!coverLetterHandled) {
            logger.info("[hirist] Cover letter option not available for this application.");
        }

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
                    `• *Portal*: \`Hirist\`\n` +
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

        // If a drawer/modal is still visible and has not been submitted, click the drawer submit button to finalize
        const drawerSubmitSelector = "div[class*='drawer'] button:has-text('Apply'), div[class*='drawer'] button:has-text('Submit'), div[class*='modal'] button:has-text('Apply'), div[class*='modal'] button:has-text('Submit'), button:has-text('Confirm Apply'), button:has-text('Submit Application'), button#submit-apply";
        const drawerSubmitBtn = page.locator(drawerSubmitSelector).filter({ visible: true }).first();
        if (await drawerSubmitBtn.count() > 0) {
            logger.info("Found drawer/modal submit button. Clicking it to finalize application...");
            await drawerSubmitBtn.click({ force: true });
            await page.waitForTimeout(4000);
        }

        // Verify successful application
        const successConfirmSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied'), :has-text('Applied successfully'), :has-text('Application Submitted')";
        const isConfirmed = await page.locator(successConfirmSelector).count() > 0;
        if (isConfirmed) {
            logger.info(`Successfully applied and verified for job_id: ${job.job_id}`);
            job.statusReason = "applied";
            return true;
        } else {
            logger.warn(`Click action performed but application confirmation not detected on Hirist. Marking as CLICKED_UNVERIFIED.`);
            job.statusReason = "clicked_unverified";
            
            // Trigger Telegram alert for unverified submission!
            const telegramService = require("../../../apps/telegram");
            await telegramService.sendMessage(
                `⚠️ *Unverified Application Alert*\n\n` +
                `• *Portal*: \`Hirist\`\n` +
                `• *Company*: *${job.company}*\n` +
                `• *Role*: *${job.title}*\n` +
                `• *Status*: \`CLICKED_UNVERIFIED\`\n\n` +
                `The apply button was clicked, but we could not verify submission confirmation. Please check manually.\n` +
                `🔗 *Job URL*: ${job.url}`
            ).catch(e => logger.error(`[hirist] Failed to send Telegram alert for unverified submission: ${e.message}`));
            
            return true;
        }
    } else {
        logger.warn(`No standard apply buttons found for job_id: ${job.job_id}. Skipping.`);
        job.statusReason = "APPLY_BUTTON_NOT_FOUND";
        return false;
    }
};

