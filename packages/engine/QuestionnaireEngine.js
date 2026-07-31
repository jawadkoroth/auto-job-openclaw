const candidateKnowledgeService = require("../knowledge/CandidateKnowledgeService");
const logger = require("../logger").plugin("naukri");

class QuestionnaireEngine {
    /**
     * Map a raw form label/name to candidate knowledge profile or AnswerBank
     * @param {string} labelText Question label or input name/placeholder
     * @param {Object} candidateProfile CandidateProfile object
     * @returns {Promise<{ resolved: boolean, answer: string, reason?: string }>}
     */
    async resolveQuestion(labelText, candidateProfile = {}) {
        const rawLabel = String(labelText || "").trim();
        if (!rawLabel) {
            return { resolved: false, answer: "", reason: "EMPTY_LABEL" };
        }

        // Try CandidateKnowledgeService.resolveQuestion
        const res = await candidateKnowledgeService.resolveQuestion({ question: rawLabel });
        if (res && res.status === "ANSWERED" && res.answer !== undefined && res.answer !== "") {
            return { resolved: true, answer: res.answer, type: res.type };
        }

        // Direct profile fallback checking
        const qLower = rawLabel.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (qLower.includes("firstname") && candidateProfile.firstName) {
            return { resolved: true, answer: candidateProfile.firstName, type: "PROFILE_FACT" };
        }
        if (qLower.includes("lastname") && candidateProfile.lastName) {
            return { resolved: true, answer: candidateProfile.lastName, type: "PROFILE_FACT" };
        }
        if ((qLower.includes("fullname") || qLower.includes("yourname")) && candidateProfile.fullName) {
            return { resolved: true, answer: candidateProfile.fullName, type: "PROFILE_FACT" };
        }
        if (qLower.includes("email") && candidateProfile.email) {
            return { resolved: true, answer: candidateProfile.email, type: "PROFILE_FACT" };
        }
        if ((qLower.includes("phone") || qLower.includes("mobile") || qLower.includes("contact")) && candidateProfile.phone) {
            return { resolved: true, answer: candidateProfile.phone, type: "PROFILE_FACT" };
        }
        if (qLower.includes("linkedin") && candidateProfile.linkedinUrl) {
            return { resolved: true, answer: candidateProfile.linkedinUrl, type: "PROFILE_FACT" };
        }
        if (qLower.includes("github") && candidateProfile.githubUrl) {
            return { resolved: true, answer: candidateProfile.githubUrl, type: "PROFILE_FACT" };
        }
        if ((qLower.includes("portfolio") || qLower.includes("website")) && candidateProfile.portfolioUrl) {
            return { resolved: true, answer: candidateProfile.portfolioUrl, type: "PROFILE_FACT" };
        }
        if (qLower.includes("notice") && candidateProfile.noticePeriod) {
            return { resolved: true, answer: String(candidateProfile.noticePeriod), type: "PROFILE_FACT" };
        }
        if (qLower.includes("currentctc") && candidateProfile.currentCTC) {
            return { resolved: true, answer: String(candidateProfile.currentCTC), type: "PROFILE_FACT" };
        }
        if ((qLower.includes("expectedctc") || qLower.includes("desiredctc") || qLower.includes("salary")) && candidateProfile.expectedCTC) {
            return { resolved: true, answer: String(candidateProfile.expectedCTC), type: "PROFILE_FACT" };
        }
        if (qLower.includes("experience") && candidateProfile.totalExperience) {
            return { resolved: true, answer: String(candidateProfile.totalExperience), type: "PROFILE_FACT" };
        }
        if (qLower.includes("location") && (candidateProfile.location || candidateProfile.currentCity)) {
            return { resolved: true, answer: candidateProfile.location || candidateProfile.currentCity, type: "PROFILE_FACT" };
        }

        return { resolved: false, answer: "", reason: res?.reason || "NO_MATCHING_KNOWLEDGE" };
    }

    /**
     * Inspect all form controls on a Playwright page, extract questions and resolve answers
     * @param {import('playwright').Page} page 
     * @param {Object} candidateProfile 
     * @returns {Promise<{ isSafeToSubmit: boolean, answers: Array<{selector: string, value: string, type: string}>, unresolvedRequired: Array<{label: string, name: string}> }>}
     */
    async analyzePageForm(page, candidateProfile = {}) {
        try {
            const formElements = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
                return inputs.map((el, idx) => {
                    const id = el.id || '';
                    const name = el.name || '';
                    const type = el.type || el.tagName.toLowerCase();
                    const required = el.required || el.getAttribute('aria-required') === 'true';

                    // Locate associated label text
                    let labelText = '';
                    if (id) {
                        const lbl = document.querySelector(`label[for="${id}"]`);
                        if (lbl) labelText = lbl.innerText;
                    }
                    if (!labelText) {
                        const parentLbl = el.closest('label');
                        if (parentLbl) labelText = parentLbl.innerText;
                    }
                    if (!labelText) {
                        const prevEl = el.previousElementSibling;
                        if (prevEl && (prevEl.tagName === 'LABEL' || prevEl.tagName === 'SPAN')) {
                            labelText = prevEl.innerText;
                        }
                    }
                    if (!labelText && el.placeholder) {
                        labelText = el.placeholder;
                    }
                    if (!labelText) {
                        labelText = name || id || `field_${idx}`;
                    }

                    // Clean label text
                    const isLabelRequired = labelText.includes('*') || labelText.toLowerCase().includes('(required)');
                    const finalRequired = required || isLabelRequired;
                    const cleanLabel = labelText.replace(/\*/g, '').replace(/\(required\)/gi, '').trim();

                    return {
                        index: idx,
                        id,
                        name,
                        type,
                        required: finalRequired,
                        label: cleanLabel,
                        currentValue: el.value || ''
                    };
                });
            }).catch(() => []);

            const answers = [];
            const unresolvedRequired = [];

            for (const item of formElements) {
                // Ignore submit buttons or search bars
                if (['submit', 'button', 'search', 'image', 'reset'].includes(item.type)) continue;

                const res = await this.resolveQuestion(item.label, candidateProfile);
                if (res.resolved) {
                    answers.push({
                        element: item,
                        value: res.answer,
                        type: item.type
                    });
                } else if (item.required && !item.currentValue) {
                    unresolvedRequired.push({
                        label: item.label,
                        name: item.name || item.id || `Field #${item.index}`
                    });
                }
            }

            return {
                isSafeToSubmit: unresolvedRequired.length === 0,
                answers,
                unresolvedRequired
            };
        } catch (err) {
            logger.error(`QuestionnaireEngine page analysis error: ${err.message}`);
            return { isSafeToSubmit: false, answers: [], unresolvedRequired: [{ label: "Form analysis error", name: err.message }] };
        }
    }
}

module.exports = new QuestionnaireEngine();
