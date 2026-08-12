const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
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
            if (!isChecked) {
                await foundCheckbox.click();
                await page.waitForTimeout(1000);
                isChecked = await foundCheckbox.isChecked();
            }
        }
    } else {
        await foundCheckbox.click();
        await page.waitForTimeout(1000);
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
        logger.error("[hirist] Cover letter checkbox checked, but textarea not found.");
        return true;
    }

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
    const jobIdStr = String(job.job_id || job.id || Date.now());
    logger.info(`Processing application for Hirist job_id ${jobIdStr}: "${job.title}" at "${job.company}"`);

    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied')";
    if (await page.locator(alreadyAppliedSelector).count() > 0) {
        logger.info(`Already applied status confirmed for job_id: ${jobIdStr}`);
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

        // --- PRE-SUBMIT EVIDENCE CAPTURE SETUP ---
        const artifactDir = path.join(process.cwd(), "sessions", "hirist", "verification", jobIdStr);
        try { fs.mkdirpSync(artifactDir); } catch (e) {}

        const networkEvents = [];
        const responseListener = (response) => {
            try {
                const resUrl = response.url();
                const status = response.status();
                const reqMethod = response.request().method();
                if (reqMethod === "POST" || reqMethod === "PUT") {
                    if (/apply|job|hirist\.tech\/api|\/j\//i.test(resUrl)) {
                        networkEvents.push({ url: resUrl, status, method: reqMethod, timestamp: new Date().toISOString() });
                    }
                }
            } catch (e) {}
        };
        page.on("response", responseListener);

        const beforeUrl = page.url();
        await page.screenshot({ path: path.join(artifactDir, "before_submit.png") }).catch(() => {});

        // Cover letter handling
        let coverLetterHandled = false;
        try {
            coverLetterHandled = await handleHiristCoverLetter(plugin, page, job, descText);
        } catch (coverErr) {
            logger.error(`[hirist] Cover letter handling encountered an error: ${coverErr.message}`);
        }

        logger.info("Clicking the Hirist Apply button...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(3000);

        if (!coverLetterHandled) {
            try {
                coverLetterHandled = await handleHiristCoverLetter(plugin, page, job, descText);
            } catch (coverErr) {
                logger.error(`[hirist] Cover letter handling error after click: ${coverErr.message}`);
            }
        }

        // Chatbot / Questionnaire check
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
                
                page.off("response", responseListener);
                job.statusReason = "questionnaire";
                return false;
            }
        }

        // Drawer/modal submit check
        const drawerSubmitSelector = "div[class*='drawer'] button:has-text('Apply'), div[class*='drawer'] button:has-text('Submit'), div[class*='modal'] button:has-text('Apply'), div[class*='modal'] button:has-text('Submit'), button:has-text('Confirm Apply'), button:has-text('Submit Application'), button#submit-apply";
        const drawerSubmitBtn = page.locator(drawerSubmitSelector).filter({ visible: true }).first();
        if (await drawerSubmitBtn.count() > 0) {
            logger.info("Found drawer/modal submit button. Clicking to finalize application...");
            await drawerSubmitBtn.click({ force: true });
            await page.waitForTimeout(4000);
        }

        // --- 7-LAYER MULTI-STAGE POST-APPLICATION VERIFICATION ENGINE ---
        await page.waitForTimeout(2000);
        page.off("response", responseListener);

        // Layer 1: Network submission evidence
        const hasNetworkSuccess = networkEvents.some(e => e.status >= 200 && e.status < 300);
        const hasNetworkError = networkEvents.some(e => e.status >= 400);

        // Layer 2: Toast / popup message verification
        const toastSelector = ".toast, .toastr, .toast-success, .toast-message, div[class*='toast'], div:has-text('Applied successfully'), div:has-text('Application sent'), div:has-text('Your application has been sent'), div:has-text('already applied'), p:has-text('Applied successfully'), div:has-text('successfully applied')";
        const toastFound = await page.locator(toastSelector).count().catch(() => 0) > 0;

        // Layer 3: Modal / drawer closure check
        const modalCount = await page.locator("div[class*='drawer'], div[class*='modal']").filter({ visible: true }).count().catch(() => 0);
        const modalClosed = (modalCount === 0);

        // Layer 4: Apply button state change check
        const successConfirmSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), button:has-text('Application Sent'), span:has-text('Application Sent'), :has-text('You have applied'), :has-text('Applied successfully'), :has-text('Application Submitted')";
        const isConfirmed = await page.locator(successConfirmSelector).count().catch(() => 0) > 0;
        const buttonText = await page.locator(applyBtnSelector).first().innerText().catch(() => "");
        const isButtonApplied = /applied|application sent|already applied/i.test(buttonText);

        // Layer 5: URL / Navigation change check
        const afterUrl = page.url();
        const urlChanged = (afterUrl !== beforeUrl);

        // Layer 6: Fresh Page Reload Verification
        await page.screenshot({ path: path.join(artifactDir, "after_submit.png") }).catch(() => {});
        logger.info("[hirist] Executing fresh page reload for authoritative DOM verification...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(2500);

        await page.screenshot({ path: path.join(artifactDir, "after_reload.png") }).catch(() => {});
        const htmlContent = await page.content().catch(() => "");
        try { fs.writeFileSync(path.join(artifactDir, "page.html"), htmlContent); } catch (e) {}

        const postReloadAppliedCount = await page.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied'), :has-text('You have applied'), button[disabled]:has-text('Applied')").count().catch(() => 0);
        const postReloadApplied = (postReloadAppliedCount > 0);

        // Layer 7: Authoritative Verdict Resolution
        let finalVerdict = "SUBMISSION_PENDING_VERIFICATION";
        let verdictReason = "Apply click executed successfully; immediate confirmation unobserved.";

        if (hasNetworkSuccess || toastFound || isConfirmed || isButtonApplied || postReloadApplied) {
            finalVerdict = "VERIFIED_APPLIED";
            verdictReason = toastFound ? "Confirmed via toast message." :
                            postReloadApplied ? "Confirmed via post-reload 'Applied' state." :
                            isButtonApplied ? "Confirmed via Apply button state change." :
                            hasNetworkSuccess ? "Confirmed via HTTP API success response." : "Confirmed via DOM state.";
        } else if (hasNetworkError) {
            finalVerdict = "APPLICATION_FAILED";
            verdictReason = `HTTP API submission error (${networkEvents.find(e => e.status >= 400)?.status || 500}).`;
        }

        // --- SAVE EVIDENCE ARTIFACTS ---
        const verificationReport = {
            jobId: jobIdStr,
            submitClicked: true,
            networkEvidence: {
                triggered: networkEvents.length > 0,
                events: networkEvents,
                hasSuccess: hasNetworkSuccess,
                hasError: hasNetworkError
            },
            confirmationEvidence: {
                toastFound,
                buttonApplied: isButtonApplied || isConfirmed
            },
            modalClosed,
            urlChanged,
            stateAfterReload: {
                alreadyApplied: postReloadApplied
            },
            finalVerdict,
            reason: verdictReason
        };

        try {
            fs.writeJsonSync(path.join(artifactDir, "verification.json"), verificationReport, { spaces: 2 });
            fs.writeJsonSync(path.join(artifactDir, "network-summary.json"), networkEvents, { spaces: 2 });
        } catch (e) {}

        // --- LIFECYCLE EVENT & DATABASE PERSISTENCE ---
        const db = require("../../database");
        const eventId = `evt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        await db.run(
            "INSERT OR IGNORE INTO application_events (event_id, job_id, portal, event_type, payload) VALUES (?, ?, ?, ?, ?)",
            [eventId, jobIdStr, "hirist", finalVerdict, JSON.stringify(verificationReport)]
        ).catch(() => {});

        const telegramService = require("../../../apps/telegram");

        if (finalVerdict === "VERIFIED_APPLIED") {
            logger.info(`[hirist] VERIFIED_APPLIED for job_id ${jobIdStr}: ${verdictReason}`);
            job.statusReason = "applied";
            job.status = "VERIFIED_APPLIED";

            await telegramService.sendApplicationSubmittedNotification({
                portal: "Hirist",
                company: job.company,
                role: job.title,
                status: "VERIFIED_APPLIED",
                url: job.url,
                jobId: jobIdStr
            }).catch(e => logger.error(`[hirist] Telegram alert error: ${e.message}`));

            return true;
        } else if (finalVerdict === "SUBMISSION_PENDING_VERIFICATION") {
            logger.warn(`[hirist] SUBMISSION_PENDING_VERIFICATION for job_id ${jobIdStr}: ${verdictReason}`);
            job.statusReason = "submission_pending_verification";
            job.status = "SUBMISSION_PENDING_VERIFICATION";

            await telegramService.sendApplicationPendingVerificationNotification({
                portal: "Hirist",
                company: job.company,
                role: job.title,
                reason: verdictReason,
                url: job.url,
                jobId: jobIdStr
            }).catch(e => logger.error(`[hirist] Telegram alert error: ${e.message}`));

            return true;
        } else {
            logger.error(`[hirist] APPLICATION_FAILED for job_id ${jobIdStr}: ${verdictReason}`);
            job.statusReason = "APPLICATION_FAILED";
            job.status = "FAILED";

            await telegramService.sendApplicationFailedNotification({
                portal: "Hirist",
                company: job.company,
                role: job.title,
                reason: verdictReason,
                url: job.url,
                jobId: jobIdStr
            }).catch(e => logger.error(`[hirist] Telegram alert error: ${e.message}`));

            return false;
        }
    } else {
        logger.warn(`No standard apply buttons found for job_id: ${jobIdStr}. Skipping.`);
        job.statusReason = "APPLY_BUTTON_NOT_FOUND";
        return false;
    }
};
