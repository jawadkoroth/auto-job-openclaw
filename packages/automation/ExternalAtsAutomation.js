const db = require("../database");
const logger = require("../logger");
const config = require("../config");
const resumeSelector = require("../resume/ResumeSelector");
const resumeManager = require("../resume/ResumeManager");
const profileManager = require("../profile/ProfileManager");
const ApplicationQuestionEngine = require("../ai/ApplicationQuestionEngine");
const telegramService = require("../../apps/telegram");
const externalApplicationRouter = require("../router/ExternalApplicationRouter");

class ExternalAtsAutomation {
    /**
     * Automate external ATS form application flow
     * @param {import("playwright").Page} page 
     * @param {Object} job 
     * @returns {Promise<boolean>}
     */
    async apply(page, job) {
        const { company, title, url } = job;
        const externalUrl = job.external_url || url;
        
        logger.worker.info(`Opening external application URL for: "${title}" at "${company}" (${externalUrl})`);
        
        try {
            await page.goto(externalUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
            await page.waitForTimeout(3000);
            
            // 1. Detect ATS type
            const ats = externalApplicationRouter.classifyATS(page.url() || externalUrl);
            logger.worker.info(`ATS Detected: ${ats}`);
            job.ats = ats;
            
            // 2. Select appropriate resume variant
            const resumeVariant = resumeSelector.selectResume(title, job.job_description || "");
            const resumePath = await resumeManager.getResumePath(job.portal || "foundit", resumeVariant);
            logger.worker.info(`Selected resume variant "${resumeVariant}" at path: ${resumePath}`);
            
            const profile = await profileManager.getProfile();

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
                    return false;
                }

                // Fill current page form fields & resume
                const stepResult = await this.fillForm(page, job, profile, resumePath);
                if (!stepResult.success) {
                    logger.worker.warn(`[External Form] Step ${currentStep} form fill returned false: ${stepResult.reason}`);
                    return false;
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
                        return true;
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
                        return true;
                    }
                    break;
                }
            }

            if (!formSubmitted && !config.search.dryRun) {
                logger.worker.warn("Max steps reached without explicit submission.");
                job.statusReason = "clicked_unverified";
                return true;
            }

            // 4. Positive Confirmation Verification (for live mode)
            const submissionConfirmed = await this.verifyConfirmation(page);
            if (submissionConfirmed) {
                logger.worker.info("External application submission positively confirmed!");
                job.statusReason = "applied";
                return true;
            } else {
                logger.worker.warn("Final submission clicked but positive confirmation message not detected. Marking CLICKED_UNVERIFIED.");
                job.statusReason = "clicked_unverified";
                return true;
            }

        } catch (error) {
            logger.worker.error(`External application automation error: ${error.message}`, error.stack);
            job.statusReason = "failed";
            return false;
        }
    }

    /**
     * Anti-Bot / CAPTCHA Detection
     */
    async detectCaptcha(page) {
        try {
            const captchaLocators = [
                "iframe[src*='captcha' i]",
                "iframe[src*='recaptcha' i]",
                "iframe[src*='turnstile' i]",
                ".g-recaptcha",
                ".h-captcha",
                "#cf-turnstile",
                "div:has-text('Verify you are human')",
                "div:has-text('Security Check')"
            ];
            for (const sel of captchaLocators) {
                const count = await page.locator(sel).count();
                if (count > 0 && await page.locator(sel).first().isVisible().catch(() => false)) {
                    return true;
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
            }

            // Locate element in Playwright
            let locator = null;
            if (field.id) {
                locator = page.locator(`#${CSS.escape(field.id)}`).first();
            } else if (field.name) {
                locator = page.locator(`[name="${CSS.escape(field.name)}"]`).first();
            } else if (field.labelText) {
                locator = page.locator(`input[aria-label*='${field.labelText}' i], textarea[aria-label*='${field.labelText}' i]`).first();
            }

            if (!locator || await locator.count() === 0) continue;

            if (isDeterministic && fillValue) {
                logger.worker.info(`[Simplify Engine] Filling deterministic field "${field.labelText}": "${fillValue}"`);
                if (field.type === "select" || field.type === "select-one") {
                    await locator.selectOption({ label: fillValue }).catch(() => locator.selectOption({ value: fillValue })).catch(() => {});
                } else {
                    await locator.fill(fillValue).catch(() => {});
                }
            } else if (field.labelText && field.labelText.length > 3) {
                // Questionnaire / Custom Question Handling
                if (this.isSensitiveQuestion(field.labelText)) {
                    logger.worker.warn(`[Simplify Engine] Sensitive question detected: "${field.labelText}". Queuing WAITING_FOR_INPUT.`);
                    await this.requestManualApproval(job, field.labelText, "Yes");
                    return { success: false, reason: "sensitive_question" };
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
                } else {
                    logger.worker.warn(`[Simplify Engine] Question requires manual input: "${field.labelText}".`);
                    await this.requestManualApproval(job, field.labelText, ansResult.answer || "Yes");
                    return { success: false, reason: "unanswered_question" };
                }
            }
        }

        return { success: true };
    }

    /**
     * Check if a question is sensitive (never guess autonomously)
     */
    isSensitiveQuestion(text) {
        const lowercase = text.toLowerCase();
        const sensitiveKeywords = [
            "sponsorship", "visa", "citizen", "authorized to work", "work authorization", "security clearance",
            "expected salary", "current salary", "compensation", "pay expectation",
            "relocate", "relocation",
            "gender", "race", "ethnicity", "disability", "veteran", "sexual orientation", "demographic",
            "criminal history", "convicted", "background check consent", "legal declaration"
        ];
        return sensitiveKeywords.some(kw => lowercase.includes(kw));
    }

    /**
     * Locate Next/Continue button
     */
    async findNextButton(page) {
        const nextSelectors = [
            "button:has-text('Next')",
            "button:has-text('Continue')",
            "button:has-text('Proceed')",
            "input[value*='Next' i]",
            "input[value*='Continue' i]"
        ];
        for (const sel of nextSelectors) {
            const loc = page.locator(sel).filter({ visible: true });
            if (await loc.count() > 0) {
                return loc.first();
            }
        }
        return null;
    }

    /**
     * Locate Final Submit button
     */
    async findSubmitButton(page) {
        const submitSelectors = [
            "button:has-text('Submit Application')",
            "button:has-text('Submit')",
            "button:has-text('Confirm & Apply')",
            "button:has-text('Apply Now')",
            "button[type='submit']",
            "input[type='submit']"
        ];
        for (const sel of submitSelectors) {
            const loc = page.locator(sel).filter({ visible: true });
            if (await loc.count() > 0) {
                return loc.first();
            }
        }
        return null;
    }

    /**
     * Positive Confirmation Message Verification
     */
    async verifyConfirmation(page) {
        try {
            const currentUrl = page.url().toLowerCase();
            const pageText = (await page.innerText("body").catch(() => "")).toLowerCase();
            
            if (currentUrl.includes("confirm") || currentUrl.includes("thank") || currentUrl.includes("success") || currentUrl.includes("applied")) {
                return true;
            }

            const successKeywords = [
                "thank you for applying",
                "application submitted",
                "application received",
                "successfully applied",
                "congratulations",
                "your application has been sent"
            ];

            return successKeywords.some(kw => pageText.includes(kw));
        } catch (e) {
            return false;
        }
    }

    /**
     * Request manual approval via Telegram & set WAITING_FOR_INPUT state
     */
    async requestManualApproval(job, question, suggestedAnswer) {
        try {
            await db.run(
                "UPDATE jobs SET status = 'WAITING_FOR_INPUT', pending_question = ?, pending_suggested_answer = ? WHERE id = ?",
                [question, suggestedAnswer, job.id]
            ).catch(() => {});
            
            await telegramService.sendMessage(
                `⚠️ *External Application Needs Input*\n\n` +
                `• *Portal*: \`External ATS\`\n` +
                `• *Company*: *${job.company}*\n` +
                `• *Role*: *${job.title}*\n\n` +
                `❓ *Question*:\n_${question}_\n\n` +
                `💡 *Suggested Answer*:\n_${suggestedAnswer}_\n\n` +
                `🔗 *Job URL*: ${job.external_url || job.url}\n\n` +
                `To approve: \`/approve ${job.id}\`\n` +
                `To custom approve: \`/approve ${job.id} <your answer>\``
            ).catch(() => {});
            
            job.statusReason = "questionnaire";
        } catch (e) {
            logger.worker.error(`Failed to request manual approval: ${e.message}`);
        }
    }
}

module.exports = new ExternalAtsAutomation();
