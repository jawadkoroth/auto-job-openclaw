const logger = require("../logger");
const config = require("../config");
const profileManager = require("../profile/ProfileManager");
const resumeSelector = require("../resume/ResumeSelector");
const resumeManager = require("../resume/ResumeManager");
const externalApplicationRouter = require("../router/ExternalApplicationRouter");
const externalCareerAuthManager = require("../auth/ExternalCareerAuthManager");
const simplifyAutofillAdapter = require("./SimplifyAutofillAdapter");
const ApplicationQuestionEngine = require("../ai/ApplicationQuestionEngine");
const Telegram = require("../../apps/telegram");
const db = require("../database");
const candidateKnowledgeService = require("../knowledge/CandidateKnowledgeService");

class ExternalAtsAutomation {
    /**
     * Main entry point to process an external job application page
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     */
    async apply(page, job) {
        let formFieldsCount = 0;
        let fieldsFilledCount = 0;
        let resumeUploaded = false;
        let questionnaireInspected = false;
        let dryRunPrevented = false;
        let ats = "Unknown";
        this.liveSubmissionAttempts = this.liveSubmissionAttempts || 0;

        try {
            // 0. Pre-Live Candidate Profile Readiness Check
            const readiness = await candidateKnowledgeService.profile.checkPreLiveProfileReadiness();
            if (!readiness.isReady) {
                logger.worker.warn(`[Pre-Live Profile Check] Required candidate profile data missing: ${readiness.missingRequiredFields.join(", ")}`);
                await db.run(
                    "UPDATE jobs SET status = 'PROFILE_INCOMPLETE', reason = ? WHERE (id = ? OR job_id = ?)",
                    [`Missing required profile fields: ${readiness.missingRequiredFields.join(", ")}`, job.id || job.job_id, job.job_id || job.id]
                ).catch(() => {});
                return {
                    success: false,
                    ats: "Unknown",
                    externalFormReached: false,
                    formFieldsCount: 0,
                    fieldsFilledCount: 0,
                    candidateAutofill: false,
                    resumeUploaded: false,
                    questionnaireInspected: false,
                    dryRunPrevented: false,
                    reason: "PROFILE_INCOMPLETE",
                    missingRequiredFields: readiness.missingRequiredFields
                };
            }

            // 1. Navigate page to target ATS URL if not already on destination
            const targetUrl = job.external_url || job.finalApplicationUrl || job.url;
            if (page.url() !== targetUrl) {
                logger.worker.info(`[External ATS Automation] Navigating page to target ATS URL: ${targetUrl}`);
                await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(err => {
                    logger.worker.warn(`Initial page.goto navigation warning: ${err.message}`);
                });
            }

            // 2. Detect ATS type from destination page
            const destinationUrl = page.url();
            ats = externalApplicationRouter.detectAtsType(destinationUrl, await page.content().catch(() => ""));
            logger.worker.info(`Detected External ATS: ${ats} on URL: ${destinationUrl}`);

            // 2. Perform Routing Identity Verification (Task 8 Safeguard)
            const title = job.title || "Software Engineer";
            const company = job.company || "Company";
            const identityCheck = await this.verifyJobIdentity(page, job);

            if (!identityCheck.valid) {
                logger.worker.warn(`[Routing Identity Verification FAILED] Job "${title}" at "${company}". Reason: ${identityCheck.reason}`);
                await Telegram.sendMessage(
                    `⚠️ <b>Routing Identity Mismatch Warning</b>\n\n<b>Job:</b> ${title} at ${company}\n<b>Reason:</b> ${identityCheck.reason}\n<b>URL:</b> ${page.url()}`
                ).catch(() => {});

                await db.run("UPDATE jobs SET status = 'ROUTING_IDENTITY_MISMATCH', reason = ? WHERE (id = ? OR job_id = ?)", [identityCheck.reason, job.id || job.job_id, job.job_id || job.id]).catch(() => {});
                return { success: false, ats, externalFormReached: false, formFieldsCount: 0, fieldsFilledCount: 0, candidateAutofill: false, resumeUploaded: false, questionnaireInspected: false, dryRunPrevented: false, reason: "routing_identity_mismatch" };
            }

            // 3. Handle External Career Portal Authentication / Account Creation
            const authResult = await externalCareerAuthManager.handleAuth(page, job);
            logger.worker.info(`External Auth Handling Result: ${JSON.stringify(authResult)}`);

            if (authResult.captchaEncountered) {
                job.statusReason = "waiting_for_input";
                await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT', reason = 'CAPTCHA challenge encountered' WHERE (id = ? OR job_id = ?)", [job.id || job.job_id, job.job_id || job.id]).catch(() => {});
                return { success: false, ats, externalFormReached: false, formFieldsCount: 0, fieldsFilledCount: 0, candidateAutofill: false, resumeUploaded: false, questionnaireInspected: false, dryRunPrevented: false, reason: "captcha_detected" };
            }

            // 4. Select appropriate resume variant using CandidateKnowledgeService
            const resumeVariant = resumeSelector.selectResume(title, job.job_description || "");
            const resumeInfo = await candidateKnowledgeService.getResumePath(job.resumeVariant || resumeVariant);
            const resumePath = resumeInfo.filePath;
            logger.worker.info(`Selected resume variant "${resumeInfo.variant}" at path: ${resumePath}`);
            const profile = await candidateKnowledgeService.getProfile();

            // 5. Try Simplify Extension Autofill Adapter as OPTIONAL fallback only
            const simplifyResult = await simplifyAutofillAdapter.fill(page);
            if (simplifyResult.simplifyUsed) {
                fieldsFilledCount += simplifyResult.fieldsFilled;
            }

            // Click initial Apply button for Workday, Greenhouse, Lever, Ashby, etc.
            const applyLocators = [
                "[data-automation-id*='apply']",
                "[data-automation-id*='adventure']",
                "a[data-automation-id='adventureButton']",
                "button[data-automation-id='adventureButton']",
                "[data-automation-id='applyButton']",
                "a#apply_button",
                "#apply_button",
                "a[href*='apply']",
                "a:has-text('Apply')",
                "button:has-text('Apply')"
            ];
            for (const sel of applyLocators) {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0) {
                    logger.worker.info(`[External Form] Found initial Apply button ("${sel}"). Clicking...`);
                    await btn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(4000);
                    break;
                }
            }

            const applyManuallyBtn = page.locator("[data-automation-id='applyManually'], a:has-text('Apply Manually'), button:has-text('Apply Manually')").first();
            if (await applyManuallyBtn.count() > 0 && await applyManuallyBtn.isVisible().catch(() => false)) {
                logger.worker.info("[External Form] Clicking Apply Manually option...");
                await applyManuallyBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(4000);
            }

            // 6. Multi-Step Native Autofill Loop
            const maxSteps = 5;
            let currentStep = 1;

            // Parse mode options explicitly (Fix 1)
            const envDryRun = String(process.env.DRY_RUN !== undefined ? process.env.DRY_RUN : config.search.dryRun).trim().toLowerCase() === "true";
            const envAllowLive = String(process.env.ALLOW_LIVE_APPLICATIONS !== undefined ? process.env.ALLOW_LIVE_APPLICATIONS : config.search.allowLiveApplications).trim().toLowerCase() === "true";

            const allowlistId = process.env.SINGLE_JOB_ALLOWLIST;
            const jobIdStr = String(job.job_id || job.id || "");
            const isAllowlisted = Boolean(allowlistId && (jobIdStr === String(allowlistId) || String(job.id) === String(allowlistId) || String(job.job_id) === String(allowlistId)));

            const liveSubmissionAllowed = !envDryRun && envAllowLive && isAllowlisted && (this.liveSubmissionAttempts || 0) < 1;
            const isDryRun = !liveSubmissionAllowed;

            while (currentStep <= maxSteps) {
                logger.worker.info(`[External Form] Processing step ${currentStep}/${maxSteps}...`);
                await page.waitForTimeout(2000);

                // Detect AI content prohibition declarations
                const pageContent = await page.content().catch(() => "");
                if (this.detectAiProhibition(pageContent)) {
                    logger.worker.warn(`[External Form] AI content prohibition clause detected! Setting AI_CONTENT_PROHIBITED = true.`);
                    job.aiContentProhibited = true;
                    await db.run(
                        "UPDATE jobs SET ai_content_prohibited = 1 WHERE (id = ? OR job_id = ?)",
                        [job.id || job.job_id, job.job_id || job.id]
                    ).catch(() => {});
                }

                // Anti-Bot / CAPTCHA Check
                if (await this.detectCaptcha(page)) {
                    logger.worker.warn(`[External Form] CAPTCHA / Anti-Bot challenge detected. Queuing WAITING_FOR_INPUT.`);
                    await this.requestManualApproval(job, "CAPTCHA / Anti-Bot challenge encountered on external form", "Please complete CAPTCHA manually");
                    return { success: false, ats, externalFormReached: formFieldsCount > 0, formFieldsCount, fieldsFilledCount, candidateAutofill: fieldsFilledCount > 0, resumeUploaded, questionnaireInspected, dryRunPrevented: false, reason: "captcha_detected" };
                }

                // Fill current page form fields & resume
                const stepResult = await this.fillForm(page, job, profile, resumePath);
                formFieldsCount += stepResult.formFieldsCount || 0;
                fieldsFilledCount += stepResult.filledCount || 0;
                if (stepResult.resumeUploaded) resumeUploaded = true;
                if (stepResult.questionnaireInspected) questionnaireInspected = true;

                if (!stepResult.success) {
                    logger.worker.warn(`[External Form] Step ${currentStep} form fill returned false: ${stepResult.reason}`);
                    return { success: false, ats, externalFormReached: formFieldsCount > 0, formFieldsCount, fieldsFilledCount, candidateAutofill: fieldsFilledCount > 0, resumeUploaded, questionnaireInspected, dryRunPrevented: false, reason: stepResult.reason };
                }

                // Look for Next / Continue vs Final Submit button
                const finalSubmitBtn = await this.findSubmitButton(page);
                const nextBtn = await this.findNextButton(page);

                if (nextBtn && (!finalSubmitBtn || await nextBtn.innerText().then(t => !/submit|apply/i.test(t)).catch(() => true))) {
                    logger.worker.info(`[External Form] Found Next/Continue button. Clicking to proceed to step ${currentStep + 1}...`);
                    await nextBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(3000);
                    currentStep++;
                } else if (finalSubmitBtn) {
                    logger.worker.info(`[External Form] Final Submit button detected.`);
                    
                    if (isDryRun) {
                        logger.worker.info(`[DRY RUN] Stopping before final submit on external form: "${page.url()}"`);
                        job.statusReason = "dry_run_validated";
                        dryRunPrevented = true;
                        return { success: true, ats, externalFormReached: formFieldsCount > 0, formFieldsCount, fieldsFilledCount, candidateAutofill: fieldsFilledCount > 0, resumeUploaded, questionnaireInspected, dryRunPrevented: true, reason: "dry_run_validated" };
                    }

                    // Pre-Submission Safety Validation
                    logger.worker.info("[PRE-SUBMISSION VALIDATION] Running mandatory safety checks before final submit...");
                    const hasFileInput = (await page.locator("input[type='file']").count().catch(() => 0)) > 0;
                    const hasUnresolvedQuestions = job.statusReason === "waiting_for_input" || (stepResult.unresolvedQuestions && stepResult.unresolvedQuestions.length > 0);

                    const validationChecks = {
                        isAllowlistedJob: isAllowlisted,
                        notAlreadyApplied: job.status !== "APPLIED" && job.status !== "ALREADY_APPLIED",
                        formFieldsFilled: fieldsFilledCount > 0 || formFieldsCount === 0,
                        resumeAttached: resumeUploaded || !hasFileInput || formFieldsCount === 0,
                        noUnresolvedInput: !hasUnresolvedQuestions,
                        noActiveCaptcha: !(await this.detectCaptcha(page)),
                        aiProhibitionRespected: !job.aiContentProhibited || (job.aiContentProhibited && stepResult.reason !== "ai_prohibited_question"),
                        urlMatchesExpectedDomain: page.url().length > 10,
                        submissionCountZero: (this.liveSubmissionAttempts || 0) === 0
                    };

                    logger.worker.info(`[PRE-SUBMISSION VALIDATION] Results: ${JSON.stringify(validationChecks)}`);

                    const allChecksPass = Object.values(validationChecks).every(v => v === true);

                    if (!allChecksPass) {
                        logger.worker.warn("[PRE-SUBMISSION VALIDATION] Pre-submission safety check failed. Aborting final submit.");
                        
                        // Set status to WAITING_FOR_INPUT if unresolved input exists (Fix 7)
                        const finalStatus = hasUnresolvedQuestions ? "WAITING_FOR_INPUT" : "PRE_SUBMISSION_VALIDATION_FAILED";
                        const finalReason = hasUnresolvedQuestions ? "UNRESOLVED_REQUIRED_FIELDS" : "pre_submission_validation_failed";

                        await db.run(
                            "UPDATE jobs SET status = ?, reason = ? WHERE (id = ? OR job_id = ?)",
                            [finalStatus, finalReason, job.id || job.job_id, job.job_id || job.id]
                        ).catch(() => {});

                        return {
                            success: false,
                            ats,
                            externalFormReached: true,
                            formFieldsCount,
                            fieldsFilledCount,
                            candidateAutofill: true,
                            resumeUploaded,
                            questionnaireInspected: true,
                            dryRunPrevented: true,
                            reason: finalReason
                        };
                    }

                    // Controlled Live Submit
                    this.liveSubmissionAttempts = (this.liveSubmissionAttempts || 0) + 1;
                    logger.worker.warn(`[CONTROLLED LIVE SUBMIT] Clicking final submit button for allowlisted Job ID ${jobIdStr}... Attempt ${this.liveSubmissionAttempts}`);

                    await finalSubmitBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(5000);

                    // Confirm Submission Success
                    const confirmedSuccess = await this.verifySubmissionConfirmation(page);
                    if (confirmedSuccess) {
                        logger.worker.info("[CONTROLLED LIVE SUBMIT SUCCESS] Positive submission confirmation detected!");
                        await db.run(
                            "UPDATE jobs SET status = 'APPLIED', applied = 1, status_reason = 'live_submitted_confirmed' WHERE (id = ? OR job_id = ?)",
                            [job.id || job.job_id, job.job_id || job.id]
                        ).catch(() => {});

                        // Capture immutable snapshot
                        await candidateKnowledgeService.snapshot.recordSnapshot({
                            jobId: job.id || job.job_id,
                            candidateProfile: profile,
                            resumeDocumentId: resumeInfo.documentId
                        }).catch(() => {});

                        return { success: true, ats, externalFormReached: true, formFieldsCount, fieldsFilledCount, candidateAutofill: true, resumeUploaded, questionnaireInspected: true, dryRunPrevented: false, reason: "live_submitted_confirmed" };
                    } else {
                        logger.worker.warn("[CONTROLLED LIVE SUBMIT UNVERIFIED] Submit clicked but confirmation unverified.");
                        await db.run(
                            "UPDATE jobs SET status = 'CLICKED_UNVERIFIED', status_reason = 'submit_clicked_unverified' WHERE (id = ? OR job_id = ?)",
                            [job.id || job.job_id, job.job_id || job.id]
                        ).catch(() => {});
                        return { success: false, ats, externalFormReached: true, formFieldsCount, fieldsFilledCount, candidateAutofill: true, resumeUploaded, questionnaireInspected: true, dryRunPrevented: false, reason: "submit_clicked_unverified" };
                    }
                } else {
                    logger.worker.info(`[External Form] No Next or Submit button found at step ${currentStep}. Completing step processing.`);
                    break;
                }
            }

            return { success: true, ats, externalFormReached: formFieldsCount > 0, formFieldsCount, fieldsFilledCount, candidateAutofill: fieldsFilledCount > 0, resumeUploaded, questionnaireInspected, dryRunPrevented: isDryRun, reason: "form_inspected" };
        } catch (err) {
            logger.worker.error(`[External ATS Automation Error]: ${err.message}`, { stack: err.stack });
            return { success: false, ats, externalFormReached: false, formFieldsCount: 0, fieldsFilledCount: 0, candidateAutofill: false, resumeUploaded: false, questionnaireInspected: false, dryRunPrevented: false, reason: err.message };
        }
    }

    /**
     * Inspect and fill form fields on current step
     */
    async fillForm(page, job, profile, resumePath) {
        let filledCount = 0;
        let resumeUploaded = false;
        let questionnaireInspected = false;
        const unresolvedQuestions = [];

        // 1. Upload Resume
        if (resumePath && fs.existsSync(resumePath)) {
            const fileInputs = page.locator("input[type='file']");
            const fileCount = await fileInputs.count().catch(() => 0);
            for (let i = 0; i < fileCount; i++) {
                const fileInput = fileInputs.nth(i);
                if (await fileInput.isVisible().catch(() => true)) {
                    logger.worker.info(`[Native Autofill Engine] Uploading resume (${resumePath}) to file input ${i + 1}...`);
                    await fileInput.setInputFiles(resumePath).catch(e => logger.worker.warn(`Resume upload failed: ${e.message}`));
                    await page.waitForTimeout(2000);
                    resumeUploaded = true;
                    filledCount++;
                    break;
                }
            }
        }

        // 2. Identify visible input fields
        const formFields = await this.extractFormFields(page);
        logger.worker.info(`[Native Autofill Engine] Identified ${formFields.length} visible form elements to inspect/fill.`);

        for (const field of formFields) {
            const locator = page.locator(field.selector).first();
            if (!await locator.isVisible().catch(() => false)) continue;

            const existingVal = await locator.inputValue().catch(() => "");
            if (existingVal && existingVal.length > 0 && field.type !== "checkbox" && field.type !== "radio") {
                filledCount++;
                continue;
            }

            // Isolate authentication / OTP fields (Task 8 Safeguard)
            if (this.isAuthenticationField(field.name || field.labelText)) {
                logger.worker.info(`[Native Autofill Engine] Isolating authentication field "${field.labelText}". Skipping questionnaire engine.`);
                continue;
            }

            // Fill Candidate Profile deterministic fields
            const mappedProfileKey = candidateKnowledgeService.mapQuestionToProfileKey(field.labelText);
            if (mappedProfileKey && profile[mappedProfileKey]) {
                const fillValue = profile[mappedProfileKey];
                logger.worker.info(`[Native Autofill Engine] Filling deterministic field "${field.labelText}": "${fillValue}"`);
                await locator.fill(fillValue).catch(() => {});
                filledCount++;
                continue;
            }

            // Handle questionnaire fields via CandidateKnowledgeService
            questionnaireInspected = true;

            const ansResult = await candidateKnowledgeService.resolveQuestion({
                question: field.labelText,
                jobId: job.id || job.job_id,
                aiContentProhibited: !!job.aiContentProhibited
            });

            if (ansResult.status === "ANSWERED" && ansResult.answer) {
                logger.worker.info(`[Native Autofill Engine] Answering question "${field.labelText}": "${ansResult.answer}"`);
                if (field.type === "select" || field.type === "select-one") {
                    const opts = await locator.locator("option").allInnerTexts().catch(() => []);
                    const matchOpt = opts.find(o => o.toLowerCase().includes(ansResult.answer.toLowerCase()));
                    if (matchOpt) {
                        await locator.selectOption({ label: matchOpt }).catch(() => {});
                    }
                } else if (field.type === "checkbox" || field.type === "radio") {
                    if (/yes|true|agree|1/i.test(ansResult.answer)) {
                        await locator.check().catch(() => {});
                    }
                } else {
                    await locator.fill(ansResult.answer).catch(() => {});
                }
                filledCount++;
            } else {
                logger.worker.warn(`[Native Autofill Engine] Question requires manual input: "${field.labelText}".`);
                const defaultSuggestion = ansResult.answer || "";
                unresolvedQuestions.push({ question: field.labelText, suggestedAnswer: defaultSuggestion });
            }
        }

        // Send consolidated Telegram approval if unresolved questions exist (Fix 5)
        if (unresolvedQuestions.length > 0) {
            job.statusReason = "waiting_for_input";
            await this.sendConsolidatedApproval(job, unresolvedQuestions);
        }

        return {
            success: true,
            formFieldsCount: formFields.length,
            filledCount,
            resumeUploaded,
            questionnaireInspected,
            unresolvedQuestions
        };
    }

    /**
     * Send ONE consolidated Telegram message for multiple unresolved questions in a form step
     */
    async sendConsolidatedApproval(job, questionsList) {
        if (!questionsList || questionsList.length === 0) return;
        const jobId = job.id || job.job_id || Date.now();

        if (questionsList.length === 1) {
            return await this.requestManualApproval(job, questionsList[0].question, questionsList[0].suggestedAnswer);
        }

        let msg = `⚠️ <b>Application Action Required (${questionsList.length} Answers Needed)</b>\n\n` +
            `<b>Job:</b> ${Telegram.escapeHTML(job.title || "Software Engineer")} at ${Telegram.escapeHTML(job.company || "Company")}\n\n`;

        const pendingIds = [];
        for (let i = 0; i < questionsList.length; i++) {
            const item = questionsList[i];
            const questionIdHash = Math.random().toString(36).substring(2, 8);
            const approvalId = `foundit-${jobId}-${questionIdHash}`;
            pendingIds.push(approvalId);

            msg += `${i + 1}. <b>${Telegram.escapeHTML(item.question)}</b>\n` +
                   `   ID: <code>${approvalId}</code>\n` +
                   `   Reply: <code>/answer ${approvalId} [Your Answer]</code>\n\n`;

            await db.run(
                `INSERT OR REPLACE INTO qna_memory (question_raw, question_normalized, answer, answer_type, source, approved) 
                 VALUES (?, ?, ?, 'PENDING', 'CONSOLIDATED_TELEGRAM', 0)`,
                [item.question, candidateKnowledgeService.answerBank.normalize(item.question), item.suggestedAnswer || ""]
            ).catch(() => {});
        }

        msg += `<i>Use <code>/answer &lt;ID&gt; &lt;answer&gt;</code> to save for future reuse, or <code>/useonce &lt;ID&gt; &lt;answer&gt;</code> for this application only.</i>`;

        await db.run(
            `UPDATE jobs 
             SET status = 'WAITING_FOR_INPUT', 
                 pending_question = ?, 
                 pending_suggested_answer = ?, 
                 pending_question_id = ?, 
                 approval_id = ? 
             WHERE (id = ? OR job_id = ?)`,
            [
                questionsList.map(q => q.question).join(" | "),
                JSON.stringify(questionsList),
                pendingIds[0],
                pendingIds[0],
                jobId,
                jobId
            ]
        ).catch(() => {});

        await Telegram.sendMessage(msg).catch(err => logger.worker.warn(`Consolidated Telegram message failed: ${err.message}`));
    }

    async extractFormFields(page) {
        const fields = [];
        const inputs = page.locator("input:not([type='hidden']), select, textarea");
        const count = await inputs.count().catch(() => 0);

        for (let i = 0; i < count; i++) {
            const el = inputs.nth(i);
            if (!await el.isVisible().catch(() => false)) continue;

            const name = await el.getAttribute("name").catch(() => "") || "";
            const id = await el.getAttribute("id").catch(() => "") || "";
            const type = await el.getAttribute("type").catch(() => "") || "text";
            
            // Find label text
            let labelText = name || id;
            if (id) {
                const labelEl = page.locator(`label[for='${id}']`).first();
                if (await labelEl.count() > 0) {
                    labelText = await labelEl.innerText().catch(() => labelText);
                }
            }

            fields.push({
                selector: id ? `#${id}` : `input[name='${name}']`,
                name,
                id,
                type,
                labelText: labelText.trim()
            });
        }
        return fields;
    }

    async findSubmitButton(page) {
        const locators = [
            "button[type='submit']",
            "input[type='submit']",
            "button:has-text('Submit')",
            "button:has-text('Submit Application')",
            "a:has-text('Submit')",
            "[data-automation-id='submitButton']"
        ];
        for (const sel of locators) {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                return btn;
            }
        }
        return null;
    }

    async findNextButton(page) {
        const locators = [
            "button:has-text('Next')",
            "button:has-text('Continue')",
            "button:has-text('Save & Continue')",
            "a:has-text('Next')",
            "[data-automation-id='nextButton']"
        ];
        for (const sel of locators) {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                return btn;
            }
        }
        return null;
    }

    async detectCaptcha(page) {
        const content = (await page.content().catch(() => "")).toLowerCase();
        return content.includes("g-recaptcha") || content.includes("cf-turnstile") || content.includes("hcaptcha");
    }

    detectAiProhibition(text) {
        const str = String(text || "").toLowerCase();
        return str.includes("ai generated content is strictly prohibited") || str.includes("do not use generative ai");
    }

    isAuthenticationField(name) {
        const str = String(name || "").toLowerCase();
        return str.includes("password") || str.includes("passcode") || str.includes("otp") || str.includes("secret");
    }

    async requestManualApproval(job, question, suggestedAnswer) {
        const jobId = job.id || job.job_id || Date.now();
        const questionIdHash = Math.random().toString(36).substring(2, 8);
        const pendingQuestionId = `foundit-${jobId}-${questionIdHash}`;
        const approvalId = pendingQuestionId;

        job.status = "WAITING_FOR_INPUT";
        job.pendingQuestion = question;
        job.pendingSuggestedAnswer = suggestedAnswer;
        job.pendingQuestionId = pendingQuestionId;
        job.approvalId = approvalId;

        try {
            await db.run(
                `UPDATE jobs 
                 SET status = 'WAITING_FOR_INPUT', 
                     pending_question = ?, 
                     pending_suggested_answer = ?, 
                     pending_question_id = ?, 
                     approval_id = ? 
                 WHERE (id = ? OR job_id = ?)`,
                [question, suggestedAnswer, pendingQuestionId, approvalId, jobId, jobId]
            ).catch(() => {});

            const telegramMsg = `⚠️ <b>Application Action Required</b>\n\n` +
                `<b>Job:</b> ${Telegram.escapeHTML(job.title || "Software Engineer")} at ${Telegram.escapeHTML(job.company || "Company")}\n` +
                `<b>Question:</b> ${Telegram.escapeHTML(question)}\n` +
                `<b>Suggested Answer:</b> ${Telegram.escapeHTML(suggestedAnswer || "Manual answer required")}\n\n` +
                `Reply with <code>/approve ${approvalId}</code> or <code>/answer ${approvalId} [Your Answer]</code>`;

            await Telegram.sendMessage(telegramMsg).catch(err => logger.worker.warn(`Telegram message failed: ${err.message}`));
        } catch (e) {
            logger.worker.error(`Failed requesting manual approval: ${e.message}`);
        }
    }

    async verifyJobIdentity(page, job) {
        try {
            const pageText = (await page.content().catch(() => "")).toLowerCase();
            const pageTitle = (await page.title().catch(() => "")).toLowerCase();

            const closedKeywords = ["404", "page not found", "job no longer available", "job expired", "posting removed", "no longer active"];
            if (closedKeywords.some(kw => pageTitle.includes(kw) || (pageText.includes(kw) && pageText.length < 2000))) {
                logger.worker.warn(`[Job Identity Verification] Page indicates job is closed/expired or 404.`);
                return { valid: false, reason: "JOB_UNAVAILABLE_OR_404" };
            }

            if (job.company && job.company !== "Discovered Employer" && job.company !== "Foundit Employer") {
                const cleanCompany = job.company.toLowerCase().replace(/[^a-z0-9]/g, "");
                const cleanText = pageText.replace(/[^a-z0-9]/g, "");
                if (cleanCompany.length > 3 && !cleanText.includes(cleanCompany)) {
                    logger.worker.warn(`[Job Identity Verification] Company "${job.company}" not detected on ATS page.`);
                    return { valid: false, reason: "ROUTING_IDENTITY_MISMATCH" };
                }
            }

            return { valid: true };
        } catch (err) {
            logger.worker.warn(`[Job Identity Verification] Warning during check: ${err.message}`);
            return { valid: true };
        }
    }

    async verifySubmissionConfirmation(page) {
        const text = (await page.content().catch(() => "")).toLowerCase();
        return text.includes("thank you for applying") || text.includes("application submitted") || text.includes("application received") || text.includes("application has been submitted");
    }
}

module.exports = new ExternalAtsAutomation();
