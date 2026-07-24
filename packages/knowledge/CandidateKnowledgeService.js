const candidateProfile = require("./CandidateProfile");
const answerBank = require("./AnswerBank");
const documentManager = require("./DocumentManager");
const coverLetterManager = require("./CoverLetterManager");
const applicationSnapshot = require("./ApplicationSnapshot");
const logger = require("../logger");

class CandidateKnowledgeService {
    constructor() {
        this.profile = candidateProfile;
        this.answerBank = answerBank;
        this.documentManager = documentManager;
        this.coverLetterManager = coverLetterManager;
        this.snapshot = applicationSnapshot;
    }

    /**
     * Get candidate profile
     */
    async getProfile() {
        return await this.profile.getProfile();
    }

    /**
     * Get candidate profile field value
     * @param {string} fieldName 
     */
    async getProfileField(fieldName) {
        return await this.profile.getField(fieldName);
    }

    /**
     * Resolve an application question using Answer Bank & Candidate Profile
     * @param {Object} params 
     * @returns {Promise<{ status: string, answer?: string, entry?: Object, reason?: string }>}
     */
    async resolveQuestion({ question, jobId, aiContentProhibited = false }) {
        const qText = String(question || "").trim();
        if (!qText) return { status: "WAITING_FOR_INPUT", answer: "", reason: "EMPTY_QUESTION" };

        // 1. Check Profile deterministic match
        const profile = await this.getProfile();
        const profileMatchKey = this.mapQuestionToProfileKey(qText);
        if (profileMatchKey && profile[profileMatchKey]) {
            logger.automation.info(`[Knowledge Service] Profile deterministic match: "${qText}" -> "${profile[profileMatchKey]}" (${profileMatchKey})`);
            return { status: "ANSWERED", answer: String(profile[profileMatchKey]), type: "PROFILE_FACT" };
        }

        // 2. Answer Bank Lookup
        const bankMatch = await this.answerBank.findAnswer(qText);
        if (bankMatch.found) {
            logger.automation.info(`[Knowledge Service] Answer Bank match: "${qText}" -> "${bankMatch.answer}" (Stale: ${bankMatch.isStale})`);
            return {
                status: "ANSWERED",
                answer: bankMatch.answer,
                entry: bankMatch.entry,
                isStale: bankMatch.isStale,
                type: "ANSWER_BANK"
            };
        }

        if (bankMatch.conflict) {
            logger.automation.warn(`[Knowledge Service] Conflicting saved answers detected for question: "${qText}". Triggering WAITING_FOR_INPUT.`);
            return { status: "WAITING_FOR_INPUT", answer: "", reason: "CONFLICTING_SAVED_ANSWERS", conflictOptions: bankMatch.options };
        }

        // 3. Sensitive / Demographic check
        if (this.isSensitiveOrDemographic(qText)) {
            logger.automation.warn(`[Knowledge Service] Sensitive/Demographic question detected: "${qText}". Routing to WAITING_FOR_INPUT.`);
            return { status: "WAITING_FOR_INPUT", answer: "Decline to self-identify", reason: "SENSITIVE_DEMOGRAPHIC" };
        }

        // 4. AI Content Prohibition Check
        if (aiContentProhibited) {
            logger.automation.warn(`[Knowledge Service] AI content prohibited. Routing question to WAITING_FOR_INPUT: "${qText}"`);
            return { status: "WAITING_FOR_INPUT", answer: "", reason: "AI_CONTENT_PROHIBITED" };
        }

        return { status: "WAITING_FOR_INPUT", answer: "", reason: "NO_MATCHING_KNOWLEDGE" };
    }

    /**
     * Get active resume PDF path matching specified variant tag
     * @param {string} variant 
     */
    async getResumePath(variant = "default") {
        return await this.documentManager.getBestResume(variant);
    }

    /**
     * Get cover letter content for company/role
     * @param {Object} params 
     */
    async getCoverLetter({ company = "", role = "" } = {}) {
        return await this.coverLetterManager.getBestCoverLetter({ company, role });
    }

    /**
     * Map common question phrases to candidate profile keys
     */
    mapQuestionToProfileKey(question) {
        const q = String(question).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (q.includes("firstname")) return "firstName";
        if (q.includes("lastname")) return "lastName";
        if (q.includes("fullname") || q.includes("yourname")) return "fullName";
        if (q.includes("email")) return "email";
        if (q.includes("phone") || q.includes("mobile") || q.includes("contactnumber")) return "phone";
        if (q.includes("linkedin")) return "linkedinUrl";
        if (q.includes("github")) return "githubUrl";
        if (q.includes("website") || q.includes("portfolio")) return "portfolioUrl";
        if (q.includes("noticeperiod") || q.includes("notice") || q.includes("howsooncanstart") || q.includes("servingnotice")) return "noticePeriod";
        if (q.includes("remotework") || q.includes("remotepreference") || q.includes("open2remote") || q.includes("workfromhome") || q.includes("wfh") || q.includes("remote")) return "remotePreference";
        if (q.includes("relocat") || q.includes("relocating") || q.includes("open2relocate")) return "relocation";
        if (q.includes("currentctc") || q.includes("currentsalary") || q.includes("presentctc") || q.includes("currentfixed")) return "currentCTC";
        if (q.includes("expectedctc") || q.includes("expectedsalary") || q.includes("salaryexpectation") || q.includes("ctcexpectation") || q.includes("desiredsalary") || q.includes("salaryexpectations")) return "expectedCTC";
        if (q.includes("totalexperience") || q.includes("overallexperience") || q.includes("yearsofexperience") || q.includes("experience")) return "totalExperience";
        if (q.includes("joiningdate") || q.includes("availability") || q.includes("whencanstart") || q.includes("earlieststart")) return "availability";
        if (q.includes("location") || q.includes("city") || q.includes("located")) return "location";
        if (q.includes("country")) return "country";
        if (q.includes("state")) return "state";
        if (q.includes("currentcompany") || q.includes("currentemployer")) return "currentCompany";
        if (q.includes("currenttitle") || q.includes("currentjobtitle") || q.includes("currentrole")) return "currentJobTitle";
        if (q.includes("school") || q.includes("university") || q.includes("college") || q.includes("institution")) return "educationSchool";
        if (q.includes("degree")) return "educationDegree";
        if (q.includes("discipline") || q.includes("fieldofstudy") || q.includes("major")) return "educationDiscipline";
        if (q.includes("startdateyear") || q.includes("educationstartyear") || q.includes("collegestartyear")) return "educationStartYear";
        if (q.includes("enddateyear") || q.includes("graduationyear") || q.includes("educationendyear")) return "educationEndYear";
        return null;
    }

    isSensitiveOrDemographic(question) {
        const q = String(question).toLowerCase();
        const keywords = [
            "disability", "disabled", "gender", "sex", "race", "ethnicity", "hispanic", "latino",
            "veteran", "military", "sexual orientation", "criminal", "background check",
            "visa sponsorship", "work authorization"
        ];
        return keywords.some(kw => q.includes(kw));
    }
}

module.exports = new CandidateKnowledgeService();
