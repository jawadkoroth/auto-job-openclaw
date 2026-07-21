const logger = require("../logger");
const config = require("../config");
const profileManager = require("../profile/ProfileManager");
const resumeSelector = require("../resume/ResumeSelector");
const resumeManager = require("../resume/ResumeManager");
const externalApplicationRouter = require("../router/ExternalApplicationRouter");
const ApplicationQuestionEngine = require("../ai/ApplicationQuestionEngine");
const Telegram = require("../../apps/telegram");
const db = require("../database");

class ExternalAtsAutomation {
    /**
     * Main entry point to process an external job application page
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     */
    async apply(page, job) {
        const title = job.title || "Software Engineer";
        const url = job.external_url || job.url;
        logger.worker.info(`Opening external application URL for: "${title}" at "${job.company || 'Unknown'}" (${url})`);

        let formFieldsCount = 0;
        let fieldsFilledCount = 0;
        let resumeUploaded = false;
        let questionnaireInspected = false;
        let dryRunPrevented = false;

        try {
            if (page.url() !== url && !page.url().includes(new URL(url).hostname)) {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
                await page.waitForTimeout(2000);
            }

            // 1. Detect ATS type using router
            const ats = externalApplicationRouter.classifyATS(page.url());
            logger.worker.info(`ATS Detected: ${ats}`);
            job.ats = ats;
            
            // 2. Select appropriate resume variant
            const resumeVariant = resumeSelector.selectResume(title, job.job_description || "");
            const resumePath = await resumeManager.getResumePath(job.portal || "foundit", resumeVariant);
            logger.worker.info(`Selected resume variant "${resumeVariant}" at path: ${resumePath}`);
            
            const profile = await profileManager.getProfile();

            // Click initial "Apply for this job" anchor/button if present to scroll/reveal application form
            const initialApplyBtn = page.locator("a#apply_button, #apply_button, a[href='#app'], a[href*='apply'], a:has-text('Apply for this job'), button:has-text('Apply for this job'), a:has-text('Apply Now'), a:has-text('Apply')").first();
            if (await initialApplyBtn.count() > 0 && await initialApplyBtn.isVisible().catch(() => false)) {
                logger.worker.info("[External Form] Clicking initial Apply button to expose form inputs...");
                await initialApplyBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(2000);
            }

            // 3. Multi-Step Form Loop
            const maxSteps = 5;
            let currentStep = 1;
            let formSubmitted = false;

            while (currentStep <= maxSteps) {
                logger.worker.info(`[External Form] Processing step ${currentStep}/${maxSteps}...`);
                await page.waitForTimeout(2000);

                // Anti-Bot / CAPTCHA Check
                if (await this.detectCaptcha(page)) {
                    logger.worker.warn(`[External Form] CAPTCHA / Anti-Bot challenge detected. Queuing WAITING_FOR_INPUT.`);
                    await this.requestManualApproval(job, "CAPTCHA / Anti-Bot challenge encountered on external form", "Please complete CAPTCHA manually");
                    return {
                        success: false,
                        ats,
                        externalFormReached: formFieldsCount > 0,
                        formFieldsCount,
                        fieldsFilledCount,
                        candidateAutofill: fieldsFilledCount > 0,
                        resumeUploaded,
                        questionnaireInspected,
                        dryRunPrevented: false,
                        reason: "captcha_detected"
                    };
                }

                // Fill current page form fields & resume
                const stepResult = await this.fillForm(page, job, profile, resumePath);
                formFieldsCount += stepResult.formFieldsCount || 0;
                fieldsFilledCount += stepResult.filledCount || 0;
                if (stepResult.resumeUploaded) resumeUploaded = true;
                if (stepResult.questionnaireInspected) questionnaireInspected = true;

                if (!stepResult.success) {
                    logger.worker.warn(`[External Form] Step ${currentStep} form fill returned false: ${stepResult.reason}`);
                    return {
                        success: false,
                        ats,
                        externalFormReached: formFieldsCount > 0,
                        formFieldsCount,
                        fieldsFilledCount,
                        candidateAutofill: fieldsFilledCount > 0,
                        resumeUploaded,
                        questionnaireInspected,
                        dryRunPrevented: false,
                        reason: stepResult.reason
                    };
                }

                // Look for Next / Continue vs Final Submit button
                const finalSubmitBtn = await this.findSubmitButton(page);
                const nextBtn = await this.findNextButton(page);

                const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;

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
                        return {
                            success: true,
                            ats,
                            externalFormReached: formFieldsCount > 0,
                            formFieldsCount,
                            fieldsFilledCount,
                            candidateAutofill: fieldsFilledCount > 0,
                            resumeUploaded,
                            questionnaireInspected,
                            dryRunPrevented: true,
                            reason: "dry_run_validated"
                        };
                    }

                    logger.worker.info("[LIVE] Attempting final submission on external form...");
                    await finalSubmitBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(5000);
                    formSubmitted = true;
                    break;
                } else {
                    logger.worker.info(`[External Form] Neither Next nor Submit button found on step ${currentStep}. Completing inspection.`);
                    if (isDryRun) {
                        job.statusReason = "dry_run_validated";
                        dryRunPrevented = formFieldsCount > 0;
                        return {
                            success: formFieldsCount > 0,
                            ats,
                            externalFormReached: formFieldsCount > 0,
                            formFieldsCount,
                            fieldsFilledCount,
                            candidateAutofill: fieldsFilledCount > 0,
                            resumeUploaded,
                            questionnaireInspected,
                            dryRunPrevented,
                            reason: formFieldsCount > 0 ? "dry_run_validated" : "no_fields_detected"
                        };
                    }
                    break;
                }
            }

            if (!formSubmitted && !config.search.dryRun) {
                logger.worker.warn("Max steps reached without explicit submission.");
                job.statusReason = "clicked_unverified";
                return {
                    success: true,
                    ats,
                    externalFormReached: formFieldsCount > 0,
                    formFieldsCount,
                    fieldsFilledCount,
                    candidateAutofill: fieldsFilledCount > 0,
                    resumeUploaded,
                    questionnaireInspected,
                    dryRunPrevented: false,
                    reason: "clicked_unverified"
                };
            }

            const submissionConfirmed = await this.verifyConfirmation(page);
            if (submissionConfirmed) {
                logger.worker.info("External application submission positively confirmed!");
                job.statusReason = "applied";
                return {
                    success: true,
                    ats,
                    externalFormReached: formFieldsCount > 0,
                    formFieldsCount,
                    fieldsFilledCount,
                    candidateAutofill: fieldsFilledCount > 0,
                    resumeUploaded,
                    questionnaireInspected,
                    dryRunPrevented: false,
                    reason: "applied"
                };
            } else {
                logger.worker.warn("Final submission clicked but positive confirmation message not detected. Marking CLICKED_UNVERIFIED.");
                job.statusReason = "clicked_unverified";
                return {
                    success: true,
                    ats,
                    externalFormReached: formFieldsCount > 0,
                    formFieldsCount,
                    fieldsFilledCount,
                    candidateAutofill: fieldsFilledCount > 0,
                    resumeUploaded,
                    questionnaireInspected,
                    dryRunPrevented: false,
                    reason: "clicked_unverified"
                };
            }

        } catch (error) {
            logger.worker.error(`External application automation error: ${error.message}`, error.stack);
            job.statusReason = "failed";
            return {
                success: false,
                ats: job.ats || "Unknown",
                externalFormReached: formFieldsCount > 0,
                formFieldsCount,
                fieldsFilledCount,
                candidateAutofill: fieldsFilledCount > 0,
                resumeUploaded,
                questionnaireInspected,
                dryRunPrevented: false,
                reason: error.message
            };
        }
    }

    /**
     * Anti-Bot / CAPTCHA Detection
     */
    async detectCaptcha(page) {
        try {
            const captchaChallengeLocators = [
                "iframe[title*='recaptcha challenge' i]",
                "iframe[src*='bframe' i]",
                "iframe[title*='hcaptcha challenge' i]",
                "#cf-turnstile iframe"
            ];
            for (const sel of captchaChallengeLocators) {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    const box = await loc.boundingBox().catch(() => null);
                    if (box && box.width > 150 && box.height > 150) {
                        return true;
                    }
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Simplify-Like Dynamic Form Autofill Engine
     */
    async fillForm(page, job, profile, resumePath) {
        let resumeUploaded = false;
        let filledCount = 0;
        let questionnaireInspected = false;

        // Upload Resume if file input present
        try {
            const fileInputs = page.locator("input[type='file']");
            const count = await fileInputs.count();
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    const input = fileInputs.nth(i);
                    if (await input.isVisible().catch(() => true)) {
                        logger.worker.info(`[Simplify Engine] Uploading resume (${resumePath}) to file input ${i + 1}...`);
                        await input.setInputFiles(resumePath).catch(err => logger.worker.warn(`Resume upload error: ${err.message}`));
                        await page.waitForTimeout(1500);
                        resumeUploaded = true;
                        break;
                    }
                }
            }
        } catch (e) {
            logger.worker.warn(`Resume upload attempt warning: ${e.message}`);
        }

        // Extract and inspect all visible form inputs across top page and embedded frames (Simplify-like DOM analysis)
        let formFields = [];
        for (const frame of page.frames()) {
            try {
                const fieldsInFrame = await frame.evaluate(() => {
                    const fields = [];
                    const elements = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='file']):not([type='submit']), textarea, select, [role='combobox']"));

                    for (const el of elements) {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") {
                            continue;
                        }

                        // Ignore header/nav/search bar inputs
                        if (el.closest("header, nav, .header, .search-bar, [role='search']")) {
                            continue;
                        }
                        if (el.type === "search" || (el.placeholder && el.placeholder.toLowerCase().includes("search")) || el.name === "q") {
                            continue;
                        }

                        let labelText = "";

                        // 1. Associated <label for="...">
                        if (el.id) {
                            const labelEl = document.querySelector(`label[for="${el.id}"]`);
                            if (labelEl) labelText = labelEl.innerText;
                        }

                        // 2. Parent/closest label container
                        if (!labelText) {
                            const closestLabel = el.closest("label");
                            if (closestLabel) labelText = closestLabel.innerText;
                        }

                        // 3. Preceding text or wrapper text
                        if (!labelText) {
                            const parent = el.parentElement;
                            if (parent && parent.innerText) {
                                const lines = parent.innerText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
                                if (lines.length > 0) labelText = lines[0];
                            }
                        }

                        // 4. Fallbacks (aria-label, placeholder, name, id)
                        if (!labelText) {
                            labelText = el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "";
                        }

                        fields.push({
                            id: el.id || "",
                            name: el.name || "",
                            type: el.type || el.tagName.toLowerCase(),
                            placeholder: el.placeholder || "",
                            autocomplete: el.getAttribute("autocomplete") || "",
                            ariaLabel: el.getAttribute("aria-label") || "",
                            labelText: labelText.replace(/[\*\:]/g, "").trim()
                        });
                    }
                    return fields;
                });
                if (fieldsInFrame && fieldsInFrame.length > 0) {
                    formFields = formFields.concat(fieldsInFrame);
                }
            } catch (frameErr) {}
        }

        logger.worker.info(`[Simplify Engine] Identified ${formFields.length} visible form elements to inspect/fill.`);

        const firstName = profile.fullName.split(" ")[0] || "";
        const lastName = profile.fullName.split(" ").slice(1).join(" ") || "";

        for (const field of formFields) {
            const labelLower = (field.labelText + " " + field.name + " " + field.placeholder + " " + field.autocomplete + " " + field.ariaLabel).toLowerCase();
            let fillValue = null;
            let isDeterministic = false;

            // Deterministic Field Matching using Profile Facts
            if (labelLower.includes("first name") || labelLower.includes("given name") || field.autocomplete === "given-name") {
                fillValue = firstName;
                isDeterministic = true;
            } else if (labelLower.includes("last name") || labelLower.includes("family name") || field.autocomplete === "family-name") {
                fillValue = lastName;
                isDeterministic = true;
            } else if (labelLower.includes("full name") || (labelLower.includes("name") && !labelLower.includes("company") && !labelLower.includes("user") && !labelLower.includes("school"))) {
                fillValue = profile.fullName;
                isDeterministic = true;
            } else if (labelLower.includes("email") || field.autocomplete === "email") {
                fillValue = profile.email;
                isDeterministic = true;
            } else if (labelLower.includes("phone") || labelLower.includes("mobile") || labelLower.includes("contact number") || field.autocomplete === "tel") {
                fillValue = profile.phone;
                isDeterministic = true;
            } else if (labelLower.includes("linkedin")) {
                fillValue = profile.socials ? profile.socials.linkedin : "";
                isDeterministic = true;
            } else if (labelLower.includes("github")) {
                fillValue = profile.socials ? profile.socials.github : "";
                isDeterministic = true;
            } else if (labelLower.includes("portfolio") || labelLower.includes("website") || labelLower.includes("personal site")) {
                fillValue = profile.socials ? profile.socials.portfolio : "";
                isDeterministic = true;
            } else if (labelLower.includes("current company") || labelLower.includes("employer") || labelLower.includes("organization")) {
                fillValue = profile.currentCompany;
                isDeterministic = true;
            } else if (labelLower.includes("city") || labelLower.includes("location") || labelLower.includes("address")) {
                fillValue = profile.location;
                isDeterministic = true;
            } else if (labelLower.includes("notice period")) {
                fillValue = profile.noticePeriod;
                isDeterministic = true;
            } else if (labelLower.includes("total experience") || labelLower.includes("years of experience")) {
                fillValue = String(profile.experienceYears);
                isDeterministic = true;
            } else if (labelLower.includes("country")) {
                fillValue = profile.country || "India";
                isDeterministic = true;
            } else if (labelLower.includes("school") || labelLower.includes("university") || labelLower.includes("college") || labelLower.includes("education")) {
                fillValue = profile.education ? (profile.education.school || profile.education.degree || "University") : "University";
                isDeterministic = true;
            } else if (labelLower.includes("degree")) {
                fillValue = profile.education ? (profile.education.degree || "Bachelor's") : "Bachelor's";
                isDeterministic = true;
            } else if (labelLower.includes("discipline") || labelLower.includes("major")) {
                fillValue = profile.education ? (profile.education.fieldOfStudy || "Computer Science") : "Computer Science";
                isDeterministic = true;
            }

            // Locate element in Playwright
            let locator = null;
            if (field.id) {
                locator = page.locator(`[id="${field.id}"]`).first();
            } else if (field.name) {
                locator = page.locator(`[name="${field.name}"]`).first();
            } else if (field.labelText) {
                locator = page.locator(`input[aria-label*='${field.labelText}' i], textarea[aria-label*='${field.labelText}' i], select[aria-label*='${field.labelText}' i]`).first();
            }

            if (!locator || await locator.count() === 0) continue;

            if (isDeterministic && fillValue) {
                logger.worker.info(`[Simplify Engine] Filling deterministic field "${field.labelText}": "${fillValue}"`);
                if (field.type === "select" || field.type === "select-one") {
                    const opts = await locator.locator("option").allInnerTexts().catch(() => []);
                    const matchOpt = opts.find(o => o.toLowerCase().includes(fillValue.toLowerCase()));
                    if (matchOpt) {
                        await locator.selectOption({ label: matchOpt }).catch(() => {});
                    } else {
                        await locator.selectOption({ label: fillValue }).catch(() => locator.selectOption({ value: fillValue })).catch(() => {});
                    }
                } else {
                    await locator.fill(fillValue).catch(() => {});
                }
                filledCount++;
            } else if (field.labelText && field.labelText.length > 3) {
                questionnaireInspected = true;
                // Questionnaire / Custom Question Handling
                if (this.isSensitiveQuestion(field.labelText)) {
                    logger.worker.warn(`[Simplify Engine] Sensitive question detected: "${field.labelText}". Queuing WAITING_FOR_INPUT.`);
                    await this.requestManualApproval(job, field.labelText, "Decline to state");
                    const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
                    if (isDryRun && filledCount > 0 && resumeUploaded) {
                        logger.worker.info("[Simplify Engine] Dry-run mode active. Continuing dry-run validation after sensitive question inspection.");
                    } else {
                        return { success: false, reason: "sensitive_question", formFieldsCount: formFields.length, filledCount, resumeUploaded, questionnaireInspected };
                    }
                }

                // AI Question Engine Priority Strategy
                const ansResult = await ApplicationQuestionEngine.answerQuestion({
                    question: field.labelText,
                    jobId: job.id,
                    jobDescription: job.job_description || "",
                    resumeText: ""
                });

                if (ansResult.status === "ANSWERED" && ansResult.answer) {
                    logger.worker.info(`[Simplify Engine] Answering question "${field.labelText}": "${ansResult.answer}"`);
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
                    logger.worker.warn(`[Simplify Engine] Question requires manual input: "${field.labelText}".`);
                    await this.requestManualApproval(job, field.labelText, ansResult.answer || "Yes");
                    const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
                    if (isDryRun && filledCount > 0 && resumeUploaded) {
                        logger.worker.info("[Simplify Engine] Dry-run mode active with successful candidate autofill & resume upload. Continuing dry-run validation.");
                    } else {
                        return { success: false, reason: "unanswered_question", formFieldsCount: formFields.length, filledCount, resumeUploaded, questionnaireInspected };
                    }
                }
            }
        }

        const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
        return {
            success: true,
            formFieldsCount: formFields.length,
            filledCount,
            resumeUploaded,
            questionnaireInspected,
            dryRunPrevented: isDryRun,
            reason: isDryRun ? "dry_run_validated" : "form_filled"
        };
    }

    /**
     * Check if a question is sensitive (never guess autonomously)
     */
    isSensitiveQuestion(text) {
        const lowercase = text.toLowerCase();
        const sensitiveKeywords = [
            "sponsorship", "visa", "citizen", "authorized to work", "work authorization", "security clearance",
            "expected salary", "current salary", "compensation", "remuneration",
            "willing to relocate", "relocation",
            "criminal history", "convicted", "background check",
            "gender", "race", "ethnicity", "veteran", "disability", "sexual orientation"
        ];
        return sensitiveKeywords.some(keyword => lowercase.includes(keyword));
    }

    async findSubmitButton(page) {
        const submitLocators = [
            "button[type='submit']",
            "input[type='submit']",
            "button:has-text('Submit Application')",
            "button:has-text('Submit')",
            "button:has-text('Apply Now')"
        ];
        for (const sel of submitLocators) {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                return btn;
            }
        }
        return null;
    }

    async findNextButton(page) {
        const nextLocators = [
            "button:has-text('Next')",
            "button:has-text('Continue')",
            "button:has-text('Proceed')",
            "button.next-btn"
        ];
        for (const sel of nextLocators) {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                return btn;
            }
        }
        return null;
    }

    async verifyConfirmation(page) {
        try {
            await page.waitForTimeout(3000);
            const content = await page.content();
            const lowerContent = content.toLowerCase();

            const successIndicators = [
                "thank you for applying",
                "application submitted",
                "application received",
                "your application has been submitted",
                "successfully applied",
                "thanks for applying"
            ];

            return successIndicators.some(indicator => lowerContent.includes(indicator));
        } catch (e) {
            return false;
        }
    }

    async requestManualApproval(job, question, suggestedAnswer) {
        job.statusReason = "waiting_for_input";
        job.pendingQuestion = question;
        job.pendingSuggestedAnswer = suggestedAnswer;

        try {
            await db.run(
                "UPDATE jobs SET status = 'WAITING_FOR_INPUT', pending_question = ?, pending_suggested_answer = ? WHERE portal = ? AND job_id = ?",
                [question, suggestedAnswer, job.portal || "foundit", job.job_id]
            ).catch(() => {});

            const telegramMsg = `⚠️ <b>Application Action Required</b>\n\n` +
                `<b>Job:</b> ${job.title} at ${job.company}\n` +
                `<b>Question:</b> ${question}\n` +
                `<b>Suggested Answer:</b> ${suggestedAnswer}\n\n` +
                `Reply with <code>/approve ${job.job_id}</code> or <code>/answer ${job.job_id} [Your Answer]</code>`;

            await Telegram.sendMessage(telegramMsg).catch(err => logger.worker.warn(`Telegram message failed: ${err.message}`));
        } catch (e) {
            logger.worker.error(`Failed requesting manual approval: ${e.message}`);
        }
    }
}

module.exports = new ExternalAtsAutomation();
