const candidateKnowledgeService = require("../../knowledge/CandidateKnowledgeService");
const telegramService = require("../../../apps/telegram");
const db = require("../../database");
const logger = require("../../logger");

class QuestionnaireEngine {
    /**
     * Detect input answer type from DOM element / container
     * @param {import("playwright").Locator} container 
     * @returns {Promise<"radio"|"checkbox"|"dropdown"|"number"|"free_text">}
     */
    async detectAnswerType(container) {
        try {
            const radioCount = await container.locator("input[type='radio'], [role='radio']").count().catch(() => 0);
            if (radioCount > 0) return "radio";

            const checkboxCount = await container.locator("input[type='checkbox'], [role='checkbox']").count().catch(() => 0);
            if (checkboxCount > 0) return "checkbox";

            const selectCount = await container.locator("select, [role='listbox'], [class*='select' i], [class*='dropdown' i]").count().catch(() => 0);
            if (selectCount > 0) return "dropdown";

            const numberInput = await container.locator("input[type='number']").count().catch(() => 0);
            if (numberInput > 0) return "number";

            return "free_text";
        } catch (e) {
            return "free_text";
        }
    }

    /**
     * Extract normalized question text from element or prompt string
     * @param {string|import("playwright").Locator} source 
     * @returns {Promise<string>}
     */
    async getQuestionText(source) {
        if (typeof source === "string") return source.trim();
        try {
            const labelText = await source.locator("label, [class*='label' i], [class*='question' i], p, span").first().innerText().catch(() => "");
            if (labelText && labelText.trim().length > 3) return labelText.trim();
            const rawText = await source.innerText().catch(() => "");
            return rawText.trim();
        } catch (e) {
            return "";
        }
    }

    /**
     * Process a questionnaire container (form/drawer/chat message)
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     * @param {import("playwright").Locator} [formContainer] 
     * @returns {Promise<{ success: boolean, status: string, pendingQuestion?: string }>}
     */
    async processQuestionnaire(page, job, formContainer = null) {
        const root = formContainer || page;

        // Locate question field blocks
        const questionSelectors = [
            "form [class*='field' i]",
            "form [class*='group' i]",
            "form [class*='question' i]",
            "[class*='Questionnaire' i] [class*='field' i]",
            "[class*='question' i]",
            "[class*='form-group' i]",
            ".FormGroup",
            "div.mb-4",
            "div.py-2"
        ];

        let questions = [];
        for (const sel of questionSelectors) {
            const locs = root.locator(sel);
            const cnt = await locs.count().catch(() => 0);
            if (cnt > 0) {
                for (let i = 0; i < cnt; i++) {
                    const el = locs.nth(i);
                    if (await el.isVisible().catch(() => false)) {
                        questions.push(el);
                    }
                }
                if (questions.length > 0) break;
            }
        }

        // Fall back to inputs directly if no field wrapper found
        if (questions.length === 0) {
            const inputs = root.locator("input:not([type='hidden']), textarea, select");
            const cnt = await inputs.count().catch(() => 0);
            for (let i = 0; i < cnt; i++) {
                questions.push(inputs.nth(i));
            }
        }

        logger.info(`[QuestionnaireEngine] Found ${questions.length} questions for job ${job.job_id}`);

        for (let idx = 0; idx < questions.length; idx++) {
            const qEl = questions[idx];
            const qText = await this.getQuestionText(qEl);
            if (!qText || qText.length < 3) continue;

            const answerType = await this.detectAnswerType(qEl);
            const normQ = candidateKnowledgeService.mapQuestionToProfileKey(qText) || qText;

            logger.info(`[QuestionnaireEngine] Question ${idx + 1}/${questions.length}: "${qText}" (Type: ${answerType})`);

            // Check if job was previously paused on this question and has pending answer
            const existingUnresolved = await db.getUnresolvedPendingQuestion("cutshort", job.job_id, qText).catch(() => null);
            
            // Resolve question via Candidate Knowledge Pipeline
            const resolved = await candidateKnowledgeService.resolveQuestion({
                question: qText,
                jobId: job.job_id,
                aiContentProhibited: Boolean(job.ai_content_prohibited)
            });

            if (resolved.status === "ANSWERED" && resolved.answer) {
                logger.info(`[QuestionnaireEngine] Resolved question: "${qText}" -> "${resolved.answer}" (${resolved.type})`);
                await this.fillAnswer(qEl, answerType, resolved.answer);
                await page.waitForTimeout(500);
            } else {
                // UNRESOLVED -> Route to WAITING_FOR_INPUT
                logger.warn(`[QuestionnaireEngine] Unresolved question: "${qText}". Transitioning job ${job.job_id} -> WAITING_FOR_INPUT`);
                
                const pendingQuestionId = db.generatePendingQuestionId(job.job_id, qText);
                const approvalId = db.generateApprovalId("cutshort", job.job_id, qText);

                await db.run(
                    `UPDATE jobs SET 
                        status = 'WAITING_FOR_INPUT', 
                        pending_question = ?, 
                        pending_question_id = ?, 
                        approval_id = ?,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE portal = 'cutshort' AND (job_id = ? OR id = ?)`,
                    [qText, pendingQuestionId, approvalId, job.job_id, job.job_id]
                );

                // Dispatch ONE Telegram Notification
                await telegramService.sendQuestionPrompt({
                    jobId: job.job_id,
                    company: job.company,
                    title: job.title,
                    question: qText,
                    portal: "cutshort",
                    approvalId: approvalId
                }).catch(e => logger.error(`[QuestionnaireEngine] Telegram notification failed: ${e.message}`));

                return {
                    success: false,
                    status: "WAITING_FOR_INPUT",
                    pendingQuestion: qText,
                    approvalId
                };
            }
        }

        return { success: true, status: "QUESTIONNAIRE_IN_PROGRESS" };
    }

    /**
     * Fill specified answer into input element based on answer type
     * @param {import("playwright").Locator} element 
     * @param {"radio"|"checkbox"|"dropdown"|"number"|"free_text"} answerType 
     * @param {string} answer 
     */
    async fillAnswer(element, answerType, answer) {
        try {
            if (answerType === "radio") {
                const radioLoc = element.locator(`input[type='radio'][value*='${answer}' i], label:has-text('${answer}')`).first();
                if (await radioLoc.isVisible().catch(() => false)) {
                    await radioLoc.click();
                    return;
                }
                const firstRadio = element.locator("input[type='radio']").first();
                if (await firstRadio.isVisible().catch(() => false)) {
                    await firstRadio.click();
                }
            } else if (answerType === "checkbox") {
                const checkLoc = element.locator(`input[type='checkbox'][value*='${answer}' i], label:has-text('${answer}')`).first();
                if (await checkLoc.isVisible().catch(() => false)) {
                    await checkLoc.check().catch(() => checkLoc.click());
                }
            } else if (answerType === "dropdown") {
                const selectEl = element.locator("select").first();
                if (await selectEl.isVisible().catch(() => false)) {
                    await selectEl.selectOption({ label: answer }).catch(() => selectEl.selectOption({ value: answer })).catch(() => selectEl.selectOption({ index: 1 }));
                } else {
                    const customDrop = element.locator("[role='listbox'], [class*='select' i]").first();
                    if (await customDrop.isVisible().catch(() => false)) {
                        await customDrop.click();
                        const opt = element.page().locator(`text='${answer}'`).first();
                        if (await opt.isVisible().catch(() => false)) {
                            await opt.click();
                        }
                    }
                }
            } else if (answerType === "number") {
                const numInput = element.locator("input[type='number'], input").first();
                if (await numInput.isVisible().catch(() => false)) {
                    const cleanNum = String(answer).replace(/\D/g, "") || "0";
                    await numInput.fill(cleanNum);
                }
            } else { // free_text
                const textInput = element.locator("textarea, input[type='text'], input:not([type='hidden'])").first();
                if (await textInput.isVisible().catch(() => false)) {
                    await textInput.fill(String(answer));
                }
            }
        } catch (e) {
            logger.warn(`[QuestionnaireEngine] Error filling answer for type ${answerType}: ${e.message}`);
        }
    }
}

module.exports = new QuestionnaireEngine();
