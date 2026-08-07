const candidateKnowledgeService = require("../../knowledge/CandidateKnowledgeService");
const telegramService = require("../../../apps/telegram");
const logger = require("../../logger").plugin("linkedin");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LinkedInApplyEngine {
    /**
     * Process Easy Apply for a target LinkedIn job card
     * @param {Page} page Playwright Page
     * @param {Object} job Target Job Card
     * @param {Object} options Options { dryRun: boolean }
     * @returns {Promise<Object>} Apply Result { status, verified, error, reason }
     */
    async applyJob(page, job, options = {}) {
        const isDryRun = options.dryRun === true || process.env.DRY_RUN === "true";
        const jobId = job.id || job.job_id;
        const jobUrl = job.url || `https://www.linkedin.com/jobs/view/${jobId}/`;

        logger.info(`[ApplyEngine] Navigating to LinkedIn Job page: ${job.title} at ${job.company} (${jobUrl}) [DRY_RUN: ${isDryRun}]`);

        try {
            await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(3000);

            // Check if already applied on page
            const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : "").catch(() => "");
            if (pageText.includes("application submitted") || pageText.includes("already applied") || pageText.includes("applied on")) {
                logger.info(`[ApplyEngine] Job ${jobId} is already applied on LinkedIn.`);
                return { status: "ALREADY_APPLIED", verified: true };
            }

            // Find Easy Apply button
            const applyBtnLocators = [
                page.locator("button.jobs-apply-button"),
                page.locator("button:has-text('Easy Apply')"),
                page.locator("div.jobs-apply-button--top-card button")
            ];

            let applyBtn = null;
            for (const loc of applyBtnLocators) {
                if (await loc.first().isVisible().catch(() => false)) {
                    applyBtn = loc.first();
                    break;
                }
            }

            if (!applyBtn) {
                logger.warn(`[ApplyEngine] Easy Apply button not visible for job ${jobId}. (May be external or closed)`);
                return { status: "SKIPPED_EXTERNAL_ONLY", verified: false, reason: "No Easy Apply button" };
            }

            logger.info(`[ApplyEngine] Clicking 'Easy Apply' button for job ${jobId}...`);
            await applyBtn.click();
            await delay(2500);

            // Easy Apply Modal Multi-Step Form Loop
            let stepCount = 0;
            const maxSteps = 10;

            while (stepCount < maxSteps) {
                stepCount++;
                const modalText = await page.evaluate(() => {
                    const modal = document.querySelector(".jobs-easy-apply-modal, div[role='dialog']");
                    return modal ? modal.innerText : "";
                }).catch(() => "");

                // Check for completion or final submit step
                const isFinalSubmitStep = /submit application|submit/i.test(modalText) && !/next/i.test(modalText);

                if (isFinalSubmitStep) {
                    if (isDryRun) {
                        logger.info(`[ApplyEngine] 🛑 [DRY_RUN] Final Submit button reached for Job ${jobId}. Form steps completed cleanly. Halting before submit.`);
                        await this.dismissModal(page);
                        return { status: "DRY_RUN_COMPLETED", verified: true, isDryRun: true };
                    } else {
                        logger.info(`[ApplyEngine] 🚀 Clicking final 'Submit application' button for Job ${jobId}...`);
                        const submitBtn = page.locator(".jobs-easy-apply-modal button:has-text('Submit application'), div[role='dialog'] button:has-text('Submit')").first();
                        if (await submitBtn.isVisible().catch(() => false)) {
                            await submitBtn.click();
                            await delay(3000);
                            return { status: "SUBMITTED", verified: true };
                        }
                    }
                }

                // Handle Questionnaire Inputs in Modal
                const unansweredQuestion = await this.fillModalQuestions(page, job);
                if (unansweredQuestion) {
                    logger.warn(`[ApplyEngine] ⚠️ Unanswered question encountered: '${unansweredQuestion}'. Halting as WAITING_FOR_INPUT.`);
                    
                    const tgMsg = `<b>❓ Candidate Action Required (LinkedIn Question)</b>\n\n` +
                        `• <b>Portal</b>: <code>LinkedIn</code>\n` +
                        `• <b>Job</b>: <code>${job.title}</code> at <code>${job.company}</code>\n` +
                        `• <b>Question</b>: <i>${unansweredQuestion}</i>\n` +
                        `• <b>Status</b>: <code>WAITING_FOR_INPUT</code>`;
                    await telegramService.sendMessage(tgMsg).catch(() => {});

                    await this.dismissModal(page);
                    return { status: "WAITING_FOR_INPUT", verified: false, reason: "UNANSWERED_QUESTION", questionText: unansweredQuestion };
                }

                // Click Next / Review Button
                const nextBtn = page.locator(".jobs-easy-apply-modal button:has-text('Next'), .jobs-easy-apply-modal button:has-text('Review'), div[role='dialog'] button:has-text('Next')").first();
                if (await nextBtn.isVisible().catch(() => false)) {
                    await nextBtn.click();
                    await delay(2000);
                } else {
                    break;
                }
            }

            if (isDryRun) {
                await this.dismissModal(page);
                return { status: "DRY_RUN_COMPLETED", verified: true, isDryRun: true };
            }

            return { status: "SUBMITTED", verified: true };

        } catch (err) {
            logger.error(`[ApplyEngine] Apply error for job ${jobId}: ${err.message}`);
            await this.dismissModal(page);
            return { status: "FAILED", verified: false, error: err.message };
        }
    }

    async fillModalQuestions(page, job) {
        // Attempt to auto-resolve input fields, dropdowns, and radio buttons using CandidateKnowledgeService
        const questionsInfo = await page.evaluate(() => {
            const modal = document.querySelector(".jobs-easy-apply-modal, div[role='dialog']");
            if (!modal) return [];

            const formGroups = Array.from(modal.querySelectorAll(".fb-dash-form-element, .jobs-easy-apply-form-element"));
            return formGroups.map(group => {
                const labelEl = group.querySelector("label, legend, span.fb-dash-form-element__label");
                const inputEl = group.querySelector("input[type='text'], input[type='number'], select, textarea");
                const labelText = labelEl ? labelEl.innerText.trim() : "";
                const val = inputEl ? inputEl.value : "";
                return { labelText, hasValue: Boolean(val && val.length > 0) };
            }).filter(q => Boolean(q.labelText));
        }).catch(() => []);

        for (const q of questionsInfo) {
            if (!q.hasValue) {
                const answer = candidateKnowledgeService.resolveQuestion ? candidateKnowledgeService.resolveQuestion(q.labelText) : null;
                if (!answer) {
                    return q.labelText; // Return unresolved question prompt
                }
            }
        }
        return null;
    }

    async dismissModal(page) {
        try {
            const closeBtn = page.locator(".jobs-easy-apply-modal button[aria-label='Dismiss'], div[role='dialog'] button[aria-label='Dismiss']").first();
            if (await closeBtn.isVisible().catch(() => false)) {
                await closeBtn.click();
                await delay(1000);
                const discardBtn = page.locator("button:has-text('Discard')").first();
                if (await discardBtn.isVisible().catch(() => false)) {
                    await discardBtn.click();
                }
            }
        } catch (e) {}
    }
}

module.exports = new LinkedInApplyEngine();
