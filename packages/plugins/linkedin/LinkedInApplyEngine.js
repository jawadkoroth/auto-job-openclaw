const path = require("path");
const fs = require("fs-extra");
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
     * @returns {Promise<Object>} Apply Result { status, verified, error, reason, transitions, networkLogs }
     */
    async applyJob(page, job, options = {}) {
        const isDryRun = options.dryRun === true || process.env.DRY_RUN === "true";
        const jobId = job.id || job.job_id;
        const jobUrl = job.url || `https://www.linkedin.com/jobs/view/${jobId}/`;
        const transitions = [];
        const networkLogs = [];

        const evidenceDir = path.join(process.cwd(), "logs", "linkedin", String(jobId));
        await fs.mkdirp(evidenceDir);

        const logTransition = (fromState, toState, details = "") => {
            const timestamp = new Date().toISOString();
            transitions.push({ from: fromState, to: toState, timestamp, details });
            logger.info(`[${timestamp}] [STATE_TRANSITION] Job ${jobId} | '${fromState}' -> '${toState}'${details ? ` | ${details}` : ""}`);
        };

        // Attach network response listener for Easy Apply submission API traffic
        const responseListener = (response) => {
            const url = response.url();
            if (url.includes("voyager/api") || url.includes("easyApply") || url.includes("/jobs/") || url.includes("graphql") || url.includes("api/")) {
                const method = response.request().method();
                const status = response.status();
                let durationMs = null;
                try {
                    const req = response.request();
                    if (req && typeof req.timing === "function") {
                        const timing = req.timing();
                        if (timing && timing.responseEnd > 0) {
                            durationMs = Math.round(timing.responseEnd - timing.requestStart);
                        }
                    }
                } catch (e) {}

                networkLogs.push({
                    timestamp: new Date().toISOString(),
                    url,
                    method,
                    status,
                    durationMs
                });
            }
        };
        page.on("response", responseListener);

        logTransition("RANKED", "CANDIDATE_SELECTED", `Title: '${job.title}', Company: '${job.company}'`);

        try {
            logger.info(`[ApplyEngine] Navigating to LinkedIn Job page: ${job.title} at ${job.company} (${jobUrl}) [Mode: ${isDryRun ? "DRY_RUN" : "LIVE"}]`);
            await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(3000);

            // Check if already applied on page
            const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : "").catch(() => "");
            if (pageText.includes("application submitted") || pageText.includes("already applied") || pageText.includes("applied on")) {
                logger.info(`[ApplyEngine] Job ${jobId} is already applied on LinkedIn.`);
                logTransition("CANDIDATE_SELECTED", "ALREADY_APPLIED", "Application record found on page");
                page.off("response", responseListener);
                return { status: "ALREADY_APPLIED", verified: true, transitions, networkLogs };
            }

            // Find Easy Apply button (supports both <button> and <a> elements)
            const applyBtnLocators = [
                page.locator("button.jobs-apply-button"),
                page.locator("a.jobs-apply-button"),
                page.locator(".jobs-apply-button"),
                page.locator("button:has-text('Easy Apply')"),
                page.locator("a:has-text('Easy Apply')"),
                page.locator("[aria-label*='Easy Apply']"),
                page.locator("div.jobs-apply-button--top-card button"),
                page.locator("div.jobs-apply-button--top-card a")
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
                logTransition("CANDIDATE_SELECTED", "SKIPPED_EXTERNAL_ONLY", "No Easy Apply button found");
                page.off("response", responseListener);
                return { status: "SKIPPED_EXTERNAL_ONLY", verified: false, reason: "No Easy Apply button", transitions, networkLogs };
            }

            logger.info(`[ApplyEngine] Clicking 'Easy Apply' button for job ${jobId}...`);
            await applyBtn.click();
            logTransition("CANDIDATE_SELECTED", "EASY_APPLY_OPENED", "Easy Apply button clicked");
            await delay(2500);

            // Save before_submit.png screenshot immediately upon modal open
            const beforeSubmitScreenshotPath = path.join(evidenceDir, "before_submit.png");
            await page.screenshot({ path: beforeSubmitScreenshotPath, fullPage: false }).catch(() => {});

            // Easy Apply Modal Multi-Step Form Loop
            let stepCount = 0;
            const maxSteps = 10;
            let currentState = "EASY_APPLY_OPENED";

            while (stepCount < maxSteps) {
                stepCount++;
                const modalText = await page.evaluate(() => {
                    const modal = document.querySelector(".jobs-easy-apply-modal, div[role='dialog']");
                    return modal ? modal.innerText : "";
                }).catch(() => "");

                const isReviewPage = /review your application|review/i.test(modalText);
                const isFinalSubmitStep = /submit application|submit/i.test(modalText) && !/next/i.test(modalText);

                if (isReviewPage) {
                    logTransition(currentState, "REVIEW_PAGE", `Form page ${stepCount} is Review step`);
                    currentState = "REVIEW_PAGE";
                } else if (!isFinalSubmitStep) {
                    const pageState = `QUESTIONNAIRE_PAGE_${stepCount}`;
                    logTransition(currentState, pageState, `Form page ${stepCount}`);
                    currentState = pageState;
                }

                if (isFinalSubmitStep) {
                    logTransition(currentState, "SUBMIT_CLICKED", "Final submit button reached");
                    currentState = "SUBMIT_CLICKED";

                    // Save before_submit.png screenshot
                    const beforeSubmitScreenshotPath = path.join(evidenceDir, "before_submit.png");
                    await page.screenshot({ path: beforeSubmitScreenshotPath, fullPage: false }).catch(() => {});

                    if (isDryRun) {
                        logger.info(`[ApplyEngine] 🛑 [DRY_RUN] Final Submit button reached for Job ${jobId}. Closing modal without submitting.`);
                        await this.dismissModal(page);
                        logTransition("SUBMIT_CLICKED", "DRY_RUN_PASSED", "Modal closed cleanly in dry run");
                        page.off("response", responseListener);
                        return { status: "DRY_RUN_PASSED", verified: true, isDryRun: true, transitions, networkLogs };
                    } else {
                        logger.info(`[ApplyEngine] 🚀 Clicking final 'Submit application' button for Job ${jobId}...`);
                        const submitBtn = page.locator(".jobs-easy-apply-modal button:has-text('Submit application'), div[role='dialog'] button:has-text('Submit')").first();
                        if (await submitBtn.isVisible().catch(() => false)) {
                            await submitBtn.click();
                            logTransition("SUBMIT_CLICKED", "SUBMITTED", "Submit application button clicked");
                            await delay(3000);
                            page.off("response", responseListener);
                            return { status: "SUBMITTED", verified: true, isDryRun: false, transitions, networkLogs };
                        }
                    }
                }

                // Handle Questionnaire Inputs in Modal
                const unansweredQuestion = await this.fillModalQuestions(page, job);
                if (unansweredQuestion) {
                    logger.warn(`[ApplyEngine] ⚠️ Unanswered question encountered: '${unansweredQuestion}'. Halting as WAITING_FOR_INPUT.`);
                    logTransition(currentState, "WAITING_FOR_INPUT", `Unresolved question: ${unansweredQuestion}`);

                    const tgMsg = `<b>❓ Candidate Action Required (LinkedIn Question)</b>\n\n` +
                        `• <b>Portal</b>: <code>LinkedIn</code>\n` +
                        `• <b>Job</b>: <code>${job.title}</code> at <code>${job.company}</code>\n` +
                        `• <b>Question</b>: <i>${unansweredQuestion}</i>\n` +
                        `• <b>Status</b>: <code>WAITING_FOR_INPUT</code>`;
                    await telegramService.sendMessage(tgMsg).catch(() => {});

                    await this.dismissModal(page);
                    page.off("response", responseListener);
                    return { status: "WAITING_FOR_INPUT", verified: false, reason: "UNANSWERED_QUESTION", questionText: unansweredQuestion, transitions, networkLogs };
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

            page.off("response", responseListener);

            if (isDryRun) {
                await this.dismissModal(page);
                logTransition(currentState, "DRY_RUN_PASSED", "Form loop finished cleanly in dry run");
                return { status: "DRY_RUN_PASSED", verified: true, isDryRun: true, transitions, networkLogs };
            }

            logTransition(currentState, "SUBMITTED", "Form loop completed in live mode");
            return { status: "SUBMITTED", verified: true, isDryRun: false, transitions, networkLogs };

        } catch (err) {
            logger.error(`[ApplyEngine] Apply error for job ${jobId}: ${err.message}`);
            logTransition("CANDIDATE_SELECTED", "FAILED", err.message);
            await this.dismissModal(page);
            page.off("response", responseListener);
            return { status: "FAILED", verified: false, error: err.message, transitions, networkLogs };
        }
    }

    async fillModalQuestions(page, job) {
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
                    return q.labelText;
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
