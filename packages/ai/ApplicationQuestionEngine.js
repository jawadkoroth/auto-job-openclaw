const aiService = require("./index");
const profileManager = require("../profile/ProfileManager");
const db = require("../database");
const telegramService = require("../../apps/telegram");
const logger = require("../logger");

class ApplicationQuestionEngine {
    /**
     * Classify and answer a job application question
     * @param {Object} params
     * @param {string} params.question The question text
     * @param {string} params.jobId SQLite job record ID
     * @param {string} [params.jobDescription] Text description of the job
     * @param {string} [params.resumeText] Text of the selected resume
     */
    async answerQuestion({ question, jobId, jobDescription = "", resumeText = "" }) {
        const profile = await profileManager.getProfile();
        
        // 1. Check Q&A Memory (SQLite) for previously approved answers
        const normalized = this.normalizeQuestion(question);
        const existing = await db.get(
            "SELECT answer, approved FROM qna_memory WHERE question_normalized = ?",
            [normalized]
        );
        if (existing) {
            logger.automation.info(`Q&A Memory Hit: "${question}" -> "${existing.answer}" (Approved: ${existing.approved})`);
            if (existing.approved) {
                return {
                    status: "ANSWERED",
                    answer: existing.answer,
                    type: "MEMORY"
                };
            } else {
                return {
                    status: "WAITING_FOR_APPROVAL",
                    answer: existing.answer,
                    type: "MEMORY"
                };
            }
        }

        // 2. Classify the question type using AI
        const classification = await this.classifyQuestion(question);
        logger.automation.info(`AI classified question "${question}" as type: ${classification.type}`);

        if (classification.type === "TYPE 1") {
            // FACTUAL: Check Candidate Profile
            const profileAnswer = this.lookupProfileField(classification.key, profile);
            if (profileAnswer !== null && profileAnswer !== undefined && profileAnswer !== "") {
                return {
                    status: "ANSWERED",
                    answer: String(profileAnswer),
                    type: "TYPE 1"
                };
            }
            
            // If factual answer is missing in profile, send Telegram approval request
            logger.automation.warn(`Factual field "${classification.key}" missing in profile for question: "${question}". Queuing for manual input.`);
            return {
                status: "WAITING_FOR_INPUT",
                type: "TYPE 1",
                key: classification.key
            };
        }

        if (classification.type === "TYPE 3") {
            // LEGAL / DEMOGRAPHIC: Return "Decline to answer" or ask
            if (classification.hasDeclineOption) {
                return {
                    status: "ANSWERED",
                    answer: "Decline to answer",
                    type: "TYPE 3"
                };
            }
            // Queue for manual review if decline is not possible/available
            return {
                status: "WAITING_FOR_INPUT",
                type: "TYPE 3"
            };
        }

        if (classification.type === "TYPE 2") {
            // PROFESSIONAL DESCRIPTIVE: Generate using AI
            const generatedAnswer = await this.generateProfessionalAnswer(question, jobDescription, profile, resumeText);
            return {
                status: "ANSWERED",
                answer: generatedAnswer,
                type: "TYPE 2"
            };
        }

        // TYPE 4 or Unknown: Queue for manual input
        return {
            status: "WAITING_FOR_INPUT",
            type: "TYPE 4"
        };
    }

    normalizeQuestion(question) {
        return question.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    }

    async classifyQuestion(question) {
        const systemPrompt = `
You are a job application question classifier. Classify the given question into one of these types:
- TYPE 1: Factual personal/professional criteria (e.g., notice period, salary, location, years of experience, work authorization, visa sponsorship).
- TYPE 2: Professional descriptive essays (e.g., "Why do you want this role?", "Describe your Kubernetes experience", "Tell us about your DevOps background").
- TYPE 3: Legal, demographic, or sensitive declarations (e.g., gender, race, disability, veteran status, background check consent).
- TYPE 4: Unknown, ambiguous, or low confidence.

For TYPE 1, identify which profile field it maps to: "fullName", "email", "phone", "location", "preferredLocations", "experienceYears", "currentCompany", "previousCompanies", "noticePeriod", "immediateJoiner", "expectedSalary", "workAuthorization", "visaRequirement", "relocationPreference", "remotePreference".
For TYPE 3, determine if it has a standard "Decline to self-identify" or "Decline to answer" option.

Format your output as a single JSON object. Return ONLY the JSON string.
Structure:
{
  "type": "TYPE 1" | "TYPE 2" | "TYPE 3" | "TYPE 4",
  "key": "mapped profile field name or null",
  "hasDeclineOption": true | false
}
`;
        try {
            const res = await aiService.parseCommand(question, systemPrompt);
            return res;
        } catch (e) {
            return { type: "TYPE 4", key: null, hasDeclineOption: false };
        }
    }

    lookupProfileField(key, profile) {
        if (!key || !profile) return null;
        if (profile[key] !== undefined) return profile[key];
        
        // Check nested fields
        if (key === "degree" || key === "graduationYear") {
            return profile.education ? profile.education[key] : null;
        }
        if (key === "linkedin" || key === "github" || key === "portfolio") {
            return profile.socials ? profile.socials[key] : null;
        }
        return null;
    }

    async generateProfessionalAnswer(question, jobDescription, profile, resumeText) {
        // Try looking up in profile's pre-approved answers (qna)
        if (profile.qna) {
            const normalizedQ = this.normalizeQuestion(question);
            for (const [qText, aText] of Object.entries(profile.qna)) {
                if (this.normalizeQuestion(qText).includes(normalizedQ) || normalizedQ.includes(this.normalizeQuestion(qText))) {
                    return aText;
                }
            }
        }

        // Generate response using OpenRouter/LLM
        const systemPrompt = `
You are an expert resume writer and DevOps specialist helping a candidate apply for a job.
Generate a concise, professional answer (1-3 sentences) to the job application question.
Base your answer ONLY on the candidate's profile and resume. Do NOT invent achievements, credentials, or metrics. Be extremely factual and authentic.

Candidate Profile:
${JSON.stringify(profile, null, 2)}

Resume Summary/Text:
${resumeText}

Job Description:
${jobDescription}
`;
        const prompt = `Question to answer: "${question}"`;
        try {
            const ans = await aiService.generateText(prompt, systemPrompt);
            return ans;
        } catch (e) {
            logger.automation.error(`Failed to generate professional answer: ${e.message}`);
            return "";
        }
    }
}

module.exports = new ApplicationQuestionEngine();
