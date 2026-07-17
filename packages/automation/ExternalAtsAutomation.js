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
     * Automate external ATS form submission
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
            const ats = externalApplicationRouter.classifyATS(externalUrl);
            logger.worker.info(`ATS Detected: ${ats}`);
            
            // 2. Select appropriate resume variant
            const resumeVariant = resumeSelector.selectResume(title, job.job_description || "");
            const resumePath = await resumeManager.getResumePath(job.portal, resumeVariant);
            logger.worker.info(`Selected resume path: ${resumePath}`);
            
            const profile = await profileManager.getProfile();
            
            // 3. Fill the forms dynamically
            const fillOk = await this.fillForm(page, job, profile, resumePath);
            if (!fillOk) {
                // If it returned false, it is either waiting for input or failed
                return false;
            }
            
            // 4. Click Submit and Verify
            logger.worker.info("Attempting to submit external application form...");
            const submitSelectors = [
                "button[type='submit']",
                "input[type='submit']",
                "button:has-text('Submit')",
                "button:has-text('Apply')",
                "input:has-text('Submit')",
                "#submit_app",
                "#submit-button"
            ];
            
            let submitBtn = null;
            for (const sel of submitSelectors) {
                const locator = page.locator(sel).filter({ visible: true });
                if (await locator.count() > 0) {
                    submitBtn = locator.first();
                    break;
                }
            }
            
            if (!submitBtn) {
                logger.worker.error("Could not find submit button on external form.");
                job.statusReason = "submit_button_missing";
                return false;
            }
            
            // Click Submit
            const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
            if (isDryRun) {
                logger.worker.info(`[DRY RUN] Would submit external application: "${externalUrl}"`);
                job.statusReason = "dry_run_validated";
                return true;
            }

            await submitBtn.click();
            await page.waitForTimeout(5000);
            
            // 5. Success confirmation check
            const successTextSelectors = [
                "thank you",
                "submitted",
                "received",
                "success",
                "confirmation",
                "congratulations",
                "applied"
            ];
            
            const currentUrl = page.url().toLowerCase();
            const pageText = (await page.innerText("body").catch(() => "")).toLowerCase();
            
            let submissionConfirmed = false;
            if (currentUrl.includes("confirm") || currentUrl.includes("thank") || currentUrl.includes("success") || currentUrl.includes("thanks")) {
                submissionConfirmed = true;
            } else {
                for (const text of successTextSelectors) {
                    if (pageText.includes(text)) {
                        submissionConfirmed = true;
                        break;
                    }
                }
            }
            
            if (submissionConfirmed) {
                logger.worker.info("External application submission confirmed successfully!");
                job.statusReason = "applied";
                return true;
            } else {
                logger.worker.warn("Submit clicked but confirmation not detected. Marking clicked_unverified.");
                job.statusReason = "clicked_unverified";
                return true; // Return true as per system standard of clicked_unverified count
            }
            
        } catch (error) {
            logger.worker.error(`External application automation crashed: ${error.message}`);
            job.statusReason = "failed";
            return false;
        }
    }
    
    /**
     * Generic form filling logic
     */
    async fillForm(page, job, profile, resumePath) {
        // Upload resume file
        try {
            const fileInput = page.locator("input[type='file'][name*='resume' i], input[type='file'][id*='resume' i], input[type='file'][accept*='pdf' i], input[type='file']");
            if (await fileInput.count() > 0) {
                logger.worker.info("Uploading resume PDF...");
                await fileInput.first().setInputFiles(resumePath);
                await page.waitForTimeout(2000);
            }
        } catch (e) {
            logger.worker.warn(`Resume file upload failed: ${e.message}`);
        }
        
        // Find all visible text inputs, textareas, selects
        const formFields = await page.evaluate(() => {
            const fields = [];
            const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='file']):not([type='submit']), textarea, select"));
            
            for (const input of inputs) {
                // Get label text
                let labelText = "";
                if (input.id) {
                    const labelEl = document.querySelector(`label[for="${input.id}"]`);
                    if (labelEl) labelText = labelEl.innerText;
                }
                
                if (!labelText) {
                    // Preceding text or placeholder fallback
                    const parent = input.parentElement;
                    if (parent && parent.innerText) {
                        labelText = parent.innerText.split("\n")[0];
                    }
                }
                
                if (!labelText) {
                    labelText = input.placeholder || input.name || input.id || "";
                }
                
                // Keep only inputs that are visible/accessible
                const rect = input.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(input).display !== "none";
                
                if (isVisible && labelText.trim().length > 0) {
                    fields.push({
                        id: input.id || "",
                        name: input.name || "",
                        type: input.type || input.tagName.toLowerCase(),
                        labelText: labelText.trim(),
                        placeholder: input.placeholder || ""
                    });
                }
            }
            return fields;
        });
        
        logger.worker.info(`Found ${formFields.length} visible form fields to inspect/fill.`);
        
        const firstName = profile.fullName.split(" ")[0] || "";
        const lastName = profile.fullName.split(" ").slice(1).join(" ") || "";
        
        for (const field of formFields) {
            const labelLower = field.labelText.toLowerCase();
            let fillValue = "";
            let isDeterministic = false;
            
            // Map common deterministic fields
            if (labelLower.includes("email")) {
                fillValue = profile.email;
                isDeterministic = true;
            } else if (labelLower.includes("phone") || labelLower.includes("mobile") || labelLower.includes("tel") || labelLower.includes("contact number")) {
                fillValue = profile.phone;
                isDeterministic = true;
            } else if (labelLower.includes("first name") || labelLower.includes("firstname")) {
                fillValue = firstName;
                isDeterministic = true;
            } else if (labelLower.includes("last name") || labelLower.includes("lastname")) {
                fillValue = lastName;
                isDeterministic = true;
            } else if (labelLower.includes("full name") || labelLower.includes("fullname") || (labelLower.includes("name") && !labelLower.includes("company") && !labelLower.includes("school"))) {
                fillValue = profile.fullName;
                isDeterministic = true;
            } else if (labelLower.includes("linkedin")) {
                fillValue = profile.socials.linkedin;
                isDeterministic = true;
            } else if (labelLower.includes("github")) {
                fillValue = profile.socials.github;
                isDeterministic = true;
            } else if (labelLower.includes("portfolio") || labelLower.includes("website") || labelLower.includes("personal site")) {
                fillValue = profile.socials.portfolio;
                isDeterministic = true;
            } else if (labelLower.includes("company") || labelLower.includes("employer") || labelLower.includes("organization")) {
                fillValue = profile.currentCompany;
                isDeterministic = true;
            }
            
            // Locate element using name, id, or text label
            let locator = null;
            if (field.id) {
                locator = page.locator(`#${CSS.escape(field.id)}`).first();
            } else if (field.name) {
                locator = page.locator(`[name="${CSS.escape(field.name)}"]`).first();
            }
            
            if (!locator || await locator.count() === 0) continue;
            
            if (isDeterministic) {
                // Fill details
                if (field.type === "select" || field.type === "select-one") {
                    await locator.selectOption({ label: fillValue }).catch(() => {});
                } else {
                    await locator.fill(fillValue).catch(() => {});
                }
            } else {
                // Treat as custom question
                // 1. Check sensitivity
                if (this.isSensitiveQuestion(field.labelText)) {
                    logger.worker.warn(`[external] Sensitive question detected: "${field.labelText}". Waiting for input.`);
                    await this.requestManualApproval(job, field.labelText, "Yes");
                    return false;
                }
                
                // 2. Answer via AI Question Engine
                const ansResult = await ApplicationQuestionEngine.answerQuestion({
                    question: field.labelText,
                    jobId: job.id,
                    jobDescription: job.job_description || "",
                    resumeText: ""
                });
                
                if (ansResult.status === "ANSWERED") {
                    logger.worker.info(`Auto-answering: "${field.labelText}" -> "${ansResult.answer}"`);
                    if (field.type === "select" || field.type === "select-one") {
                        // Dropdown selection helper
                        const selectElement = await locator.elementHandle();
                        const options = await selectElement.$$eval("option", opts => opts.map(o => ({ text: o.text, value: o.value })));
                        
                        // Look for closest option
                        let bestVal = options[0]?.value;
                        const matchText = ansResult.answer.toLowerCase();
                        for (const opt of options) {
                            if (opt.text.toLowerCase().includes(matchText) || matchText.includes(opt.text.toLowerCase())) {
                                bestVal = opt.value;
                                break;
                            }
                        }
                        await selectElement.selectOption(bestVal).catch(() => {});
                    } else if (field.type === "checkbox" || field.type === "radio") {
                        const matchText = ansResult.answer.toLowerCase();
                        if (matchText === "yes" || matchText === "true" || matchText === "1" || matchText.includes("agree")) {
                            await locator.check().catch(() => {});
                        }
                    } else {
                        await locator.fill(ansResult.answer).catch(() => {});
                    }
                } else {
                    logger.worker.warn(`[external] Question needs approval: "${field.labelText}".`);
                    await this.requestManualApproval(job, field.labelText, ansResult.answer || "Yes");
                    return false;
                }
            }
        }
        
        return true;
    }
    
    isSensitiveQuestion(text) {
        const lowercase = text.toLowerCase();
        const keywords = [
            "sponsorship", "visa", "citizen", "authorized", "clearance", "work authorization",
            "salary", "expectation", "pay", "compensation", "expected salary",
            "relocate", "relocation",
            "gender", "race", "disability", "veteran", "ethnic", "sex", "orientation"
        ];
        return keywords.some(kw => lowercase.includes(kw));
    }
    
    async requestManualApproval(job, question, suggestedAnswer) {
        const db = require("../database");
        await db.run(
            "UPDATE jobs SET status = 'WAITING_FOR_INPUT', pending_question = ?, pending_suggested_answer = ? WHERE id = ?",
            [question, suggestedAnswer, job.id]
        );
        
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
    }
}

module.exports = new ExternalAtsAutomation();
