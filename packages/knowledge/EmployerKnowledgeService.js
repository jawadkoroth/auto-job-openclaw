const db = require("../database");
const logger = require("../logger").automation;

class EmployerKnowledgeService {
    /**
     * Get stored intelligence for a company on a portal
     * @param {string} portal 
     * @param {string} companyName 
     * @returns {Promise<Object|null>}
     */
    async getEmployerKnowledge(portal, companyName) {
        if (!portal || !companyName) return null;
        await db.init();
        const normCompany = String(companyName).trim();
        const row = await db.get(
            "SELECT * FROM employer_knowledge WHERE LOWER(portal) = LOWER(?) AND LOWER(company_name) = LOWER(?)",
            [portal, normCompany]
        ).catch(() => null);

        if (!row) return null;

        try {
            return {
                ...row,
                question_patterns: row.question_patterns ? JSON.parse(row.question_patterns) : [],
                common_questionnaire: row.common_questionnaire ? JSON.parse(row.common_questionnaire) : []
            };
        } catch (e) {
            return row;
        }
    }

    /**
     * Record or update employer intelligence for a company
     * @param {Object} data 
     */
    async updateEmployerKnowledge({
        portal,
        companyName,
        recruiterName,
        questionPattern,
        questionnaireItem,
        noticeQuestion,
        salaryQuestion,
        codingTestProvider,
        interviewProcess,
        averageResponseDays
    }) {
        if (!portal || !companyName) return;
        await db.init();
        const normCompany = String(companyName).trim();

        const existing = await this.getEmployerKnowledge(portal, normCompany);
        let patterns = existing && Array.isArray(existing.question_patterns) ? existing.question_patterns : [];
        let questionnaires = existing && Array.isArray(existing.common_questionnaire) ? existing.common_questionnaire : [];

        if (questionPattern && !patterns.includes(questionPattern)) {
            patterns.push(questionPattern);
        }
        if (questionnaireItem && !questionnaires.some(q => q.question === questionnaireItem.question)) {
            questionnaires.push(questionnaireItem);
        }

        const recruiter = recruiterName || (existing ? existing.recruiter_name : null);
        const notice = noticeQuestion || (existing ? existing.expected_notice_question : null);
        const salary = salaryQuestion || (existing ? existing.expected_salary_question : null);
        const coding = codingTestProvider || (existing ? existing.coding_test_provider : null);
        const interview = interviewProcess || (existing ? existing.interview_process : null);
        const respDays = averageResponseDays || (existing ? existing.average_response_days : null);

        await db.run(
            `INSERT INTO employer_knowledge (
                portal, company_name, recruiter_name, question_patterns, common_questionnaire,
                expected_notice_question, expected_salary_question, coding_test_provider,
                interview_process, average_response_days, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(portal, company_name) DO UPDATE SET
                recruiter_name = COALESCE(excluded.recruiter_name, employer_knowledge.recruiter_name),
                question_patterns = excluded.question_patterns,
                common_questionnaire = excluded.common_questionnaire,
                expected_notice_question = COALESCE(excluded.expected_notice_question, employer_knowledge.expected_notice_question),
                expected_salary_question = COALESCE(excluded.expected_salary_question, employer_knowledge.expected_salary_question),
                coding_test_provider = COALESCE(excluded.coding_test_provider, employer_knowledge.coding_test_provider),
                interview_process = COALESCE(excluded.interview_process, employer_knowledge.interview_process),
                average_response_days = COALESCE(excluded.average_response_days, employer_knowledge.average_response_days),
                updated_at = CURRENT_TIMESTAMP`,
            [
                portal,
                normCompany,
                recruiter,
                JSON.stringify(patterns),
                JSON.stringify(questionnaires),
                notice,
                salary,
                coding,
                interview,
                respDays
            ]
        );

        logger.info(`[EmployerKnowledge] Updated intelligence for company "${normCompany}" on portal "${portal}"`);
    }

    /**
     * Get all employer knowledge entries
     * @returns {Promise<Array<Object>>}
     */
    async getAllEmployerKnowledge() {
        await db.init();
        const rows = await db.all("SELECT * FROM employer_knowledge ORDER BY updated_at DESC").catch(() => []);
        return rows.map(r => {
            try {
                return {
                    ...r,
                    question_patterns: r.question_patterns ? JSON.parse(r.question_patterns) : [],
                    common_questionnaire: r.common_questionnaire ? JSON.parse(r.common_questionnaire) : []
                };
            } catch (e) {
                return r;
            }
        });
    }
}

module.exports = new EmployerKnowledgeService();
