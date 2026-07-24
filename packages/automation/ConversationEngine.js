const db = require("../database");
const eventBus = require("../events/EventBus");
const candidateKnowledgeService = require("../knowledge/CandidateKnowledgeService");
const employerKnowledgeService = require("../knowledge/EmployerKnowledgeService");
const telegramService = require("../../apps/telegram");
const logger = require("../logger").automation;

class ConversationEngine {
    /**
     * Get or initialize a normalized conversation record
     * @param {Object} params 
     * @returns {Promise<Object>}
     */
    async getOrCreateConversation({ conversationId, portal, jobId, company, recruiterName }) {
        await db.init();
        const existing = await db.get(
            "SELECT * FROM conversations WHERE conversation_id = ?",
            [conversationId]
        ).catch(() => null);

        if (existing) return existing;

        await db.run(
            `INSERT INTO conversations (
                conversation_id, portal, job_id, company, recruiter_name, conversation_status
            ) VALUES (?, ?, ?, ?, ?, 'CONVERSATION_CREATED')`,
            [conversationId, portal, jobId, company || "", recruiterName || "Recruiter"]
        );

        eventBus.publish(eventBus.EVENTS.CONVERSATION_CREATED, {
            conversationId,
            portal,
            jobId,
            company
        });

        return await db.get("SELECT * FROM conversations WHERE conversation_id = ?", [conversationId]);
    }

    /**
     * Update conversation status and timestamps
     * @param {string} conversationId 
     * @param {Object} updates 
     */
    async updateConversation(conversationId, updates) {
        await db.init();
        const setClauses = ["updated_at = CURRENT_TIMESTAMP"];
        const params = [];

        for (const [k, v] of Object.entries(updates)) {
            setClauses.push(`${k} = ?`);
            params.push(v);
        }
        params.push(conversationId);

        await db.run(
            `UPDATE conversations SET ${setClauses.join(", ")} WHERE conversation_id = ?`,
            params
        );
    }

    /**
     * Get active conversations that need monitoring
     * @param {string} [portal] 
     * @returns {Promise<Array<Object>>}
     */
    async getActiveConversations(portal = null) {
        await db.init();
        const activeStatuses = [
            "CONVERSATION_CREATED",
            "EMPLOYER_PENDING",
            "QUESTIONNAIRE_PENDING",
            "QUESTIONNAIRE_IN_PROGRESS",
            "INTERVIEW_PENDING",
            "WAITING_FOR_INPUT",
            "READY_TO_RESUME"
        ];

        const placeholders = activeStatuses.map(() => "?").join(",");
        let sql = `SELECT * FROM conversations WHERE closed = 0 AND conversation_status IN (${placeholders})`;
        const params = [...activeStatuses];

        if (portal) {
            sql += " AND LOWER(portal) = LOWER(?)";
            params.push(portal);
        }

        sql += " ORDER BY last_checked_at ASC NULLS FIRST";
        return await db.all(sql, params).catch(() => []);
    }

    /**
     * Question Resolution Pipeline (Phase 5)
     * Normalize -> Canonical -> Candidate Profile -> Answer Bank -> Semantic -> Employer Knowledge -> Telegram
     * @param {Object} params 
     * @returns {Promise<{ status: "ANSWERED"|"WAITING_FOR_INPUT", answer?: string, type?: string, approvalId?: string }>}
     */
    async resolveQuestion({ questionText, portal, jobId, company }) {
        const rawQ = String(questionText || "").trim();
        if (!rawQ) return { status: "WAITING_FOR_INPUT", answer: "", type: "EMPTY_QUESTION" };

        logger.info(`[ConversationEngine] Resolving question pipeline for "${rawQ}" (Portal: ${portal}, Job: ${jobId})`);

        // 1. Candidate Knowledge Service (Candidate Profile & Answer Bank)
        const resolved = await candidateKnowledgeService.resolveQuestion({
            question: rawQ,
            jobId,
            aiContentProhibited: false
        });

        if (resolved.status === "ANSWERED" && resolved.answer) {
            // Update Employer Knowledge pattern
            await employerKnowledgeService.updateEmployerKnowledge({
                portal,
                companyName: company,
                questionPattern: rawQ
            }).catch(() => {});

            eventBus.publish(eventBus.EVENTS.QUESTION_ANSWERED, {
                portal,
                jobId,
                company,
                question: rawQ,
                answer: resolved.answer,
                source: resolved.type
            });

            return resolved;
        }

        // 2. Check Employer Knowledge for recurring common questionnaire answers
        const empKnowledge = await employerKnowledgeService.getEmployerKnowledge(portal, company);
        if (empKnowledge && Array.isArray(empKnowledge.common_questionnaire)) {
            const normQ = candidateKnowledgeService.mapQuestionToProfileKey(rawQ) || rawQ;
            const match = empKnowledge.common_questionnaire.find(item => item.question === rawQ || item.question === normQ);
            if (match && match.answer) {
                logger.info(`[ConversationEngine] Resolved via Employer Knowledge match: "${rawQ}" -> "${match.answer}"`);

                eventBus.publish(eventBus.EVENTS.QUESTION_ANSWERED, {
                    portal,
                    jobId,
                    company,
                    question: rawQ,
                    answer: match.answer,
                    source: "EMPLOYER_KNOWLEDGE"
                });

                return { status: "ANSWERED", answer: match.answer, type: "EMPLOYER_KNOWLEDGE" };
            }
        }

        // 3. Unresolved -> Route to WAITING_FOR_INPUT & Telegram
        logger.warn(`[ConversationEngine] Unresolved question: "${rawQ}". Triggering WAITING_FOR_INPUT & Telegram prompt.`);
        const approvalId = db.generateApprovalId(portal, jobId, rawQ);
        const pendingQuestionId = db.generatePendingQuestionId(jobId, rawQ);

        // Update Job table for single application pause
        await db.run(
            `UPDATE jobs SET 
                status = 'WAITING_FOR_INPUT',
                pending_question = ?,
                pending_question_id = ?,
                approval_id = ?,
                updated_at = CURRENT_TIMESTAMP
             WHERE portal = ? AND (job_id = ? OR id = ?)`,
            [rawQ, pendingQuestionId, approvalId, portal, jobId, jobId]
        );

        eventBus.publish(eventBus.EVENTS.WAITING_FOR_INPUT, {
            portal,
            jobId,
            company,
            question: rawQ,
            approvalId
        });

        // Dispatch Telegram Notification
        await telegramService.sendQuestionPrompt({
            jobId,
            company,
            title: "Application Question",
            question: rawQ,
            portal,
            approvalId
        }).catch(e => logger.error(`[ConversationEngine] Telegram prompt failed: ${e.message}`));

        return {
            status: "WAITING_FOR_INPUT",
            answer: "",
            approvalId
        };
    }

    /**
     * Mark conversation polling check timestamp
     * @param {string} conversationId 
     */
    async touchLastChecked(conversationId) {
        await db.run(
            "UPDATE conversations SET last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?",
            [conversationId]
        ).catch(() => {});
    }
}

module.exports = new ConversationEngine();
