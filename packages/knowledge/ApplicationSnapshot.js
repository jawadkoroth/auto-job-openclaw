const db = require("../database");

class ApplicationSnapshot {
    /**
     * Record an immutable application snapshot
     * @param {Object} params 
     */
    async recordSnapshot({ jobId, candidateProfile, resumeDocumentId, coverLetterId, answerBankIdsUsed = [], oneTimeAnswersUsed = {} }) {
        await db.init().catch(() => {});

        const snapshotData = {
            job_id: String(jobId),
            candidate_profile_snapshot: JSON.stringify(candidateProfile || {}),
            resume_document_id: String(resumeDocumentId || ""),
            cover_letter_id: String(coverLetterId || ""),
            answer_bank_ids_used: JSON.stringify(answerBankIdsUsed || []),
            one_time_answers_used: JSON.stringify(oneTimeAnswersUsed || {})
        };

        const res = await db.run(
            `INSERT INTO application_snapshots 
             (job_id, candidate_profile_snapshot, resume_document_id, cover_letter_id, answer_bank_ids_used, one_time_answers_used) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                snapshotData.job_id,
                snapshotData.candidate_profile_snapshot,
                snapshotData.resume_document_id,
                snapshotData.cover_letter_id,
                snapshotData.answer_bank_ids_used,
                snapshotData.one_time_answers_used
            ]
        );

        return res.lastID;
    }

    /**
     * Retrieve snapshot for a job ID
     * @param {string} jobId 
     */
    async getSnapshot(jobId) {
        await db.init().catch(() => {});
        const row = await db.get("SELECT * FROM application_snapshots WHERE job_id = ? ORDER BY id DESC", [String(jobId)]).catch(() => null);
        if (!row) return null;

        return {
            id: row.id,
            jobId: row.job_id,
            candidateProfile: JSON.parse(row.candidate_profile_snapshot || "{}"),
            resumeDocumentId: row.resume_document_id,
            coverLetterId: row.cover_letter_id,
            answerBankIdsUsed: JSON.parse(row.answer_bank_ids_used || "[]"),
            oneTimeAnswersUsed: JSON.parse(row.one_time_answers_used || "{}"),
            timestamp: row.timestamp
        };
    }
}

module.exports = new ApplicationSnapshot();
