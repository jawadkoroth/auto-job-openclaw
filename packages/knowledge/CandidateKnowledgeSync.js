const db = require("../database");
const candidateProfile = require("./CandidateProfile");
const fs = require("fs-extra");
const path = require("path");

class CandidateKnowledgeSync {
    constructor() {
        this.syncFilePath = path.join(process.cwd(), "sessions", "candidate_knowledge_sync.json");
    }

    /**
     * Export sanitized Candidate Knowledge data from local SQLite DB to sync JSON payload
     * @returns {Promise<string>} Path to generated sync payload
     */
    async exportSyncPayload() {
        await db.init();
        await fs.ensureDir(path.dirname(this.syncFilePath));

        const profileRows = await db.all("SELECT key, value, category FROM candidate_profile").catch(() => []);
        const answerBankRows = await db.all("SELECT canonical_key, original_question, normalized_question, approved_answer, answer_type, is_sensitive, auto_use_enabled, confidence_threshold, review_after, expires_at FROM answer_bank").catch(() => []);
        const documentRows = await db.all("SELECT document_id, filename, filepath, variant, tags, is_active, is_default FROM documents").catch(() => []);
        const coverLetterRows = await db.all("SELECT cover_letter_id, title, content, target_role, target_company, is_active, is_default FROM cover_letters").catch(() => []);

        // Canonicalize profile keys and filter out sensitive credentials
        const sanitizedProfile = [];
        for (const r of profileRows) {
            const canonKey = candidateProfile.getCanonicalKey(r.key);
            const kLower = String(canonKey || "").toLowerCase();
            if (kLower.includes("password") || kLower.includes("token") || kLower.includes("cookie") || kLower.includes("secret") || kLower.includes("otp")) {
                continue;
            }
            sanitizedProfile.push({
                key: canonKey,
                value: r.value,
                category: r.category || "general"
            });
        }

        const syncPayload = {
            version: "1.0",
            timestamp: new Date().toISOString(),
            candidate_profile: sanitizedProfile,
            answer_bank: answerBankRows,
            documents: documentRows,
            cover_letters: coverLetterRows
        };

        await fs.writeJson(this.syncFilePath, syncPayload, { spaces: 2 });
        return this.syncFilePath;
    }

    /**
     * Import/Upsert synchronized Candidate Knowledge data into SQLite DB
     * @param {string} [filePath] 
     * @returns {Promise<{ profileCount: number, answerBankCount: number, documentsCount: number, coverLettersCount: number }>}
     */
    async importSyncPayload(filePath) {
        await db.init();
        const targetPath = filePath || this.syncFilePath;

        if (!await fs.pathExists(targetPath)) {
            throw new Error(`Sync payload file not found at: ${targetPath}`);
        }

        const payload = await fs.readJson(targetPath);
        let profileCount = 0;
        let answerBankCount = 0;
        let documentsCount = 0;
        let coverLettersCount = 0;

        // 1. Upsert candidate_profile
        if (Array.isArray(payload.candidate_profile)) {
            for (const row of payload.candidate_profile) {
                const canonKey = candidateProfile.getCanonicalKey(row.key);
                if (!canonKey) continue;
                await db.run(
                    `INSERT INTO candidate_profile (key, value, category, updated_at) 
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP) 
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP`,
                    [canonKey, row.value, row.category || "general"]
                );
                profileCount++;
            }
        }

        // 2. Upsert answer_bank
        if (Array.isArray(payload.answer_bank)) {
            for (const row of payload.answer_bank) {
                await db.run(
                    `INSERT INTO answer_bank 
                     (canonical_key, original_question, normalized_question, approved_answer, answer_type, is_sensitive, auto_use_enabled, confidence_threshold, review_after, expires_at, updated_at) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) 
                     ON CONFLICT(normalized_question) DO UPDATE SET 
                     approved_answer = excluded.approved_answer, canonical_key = excluded.canonical_key, auto_use_enabled = excluded.auto_use_enabled, updated_at = CURRENT_TIMESTAMP`,
                    [
                        row.canonical_key, row.original_question, row.normalized_question, 
                        row.approved_answer, row.answer_type || "FACTUAL", row.is_sensitive ? 1 : 0, 
                        row.auto_use_enabled ? 1 : 0, row.confidence_threshold || 0.8, 
                        row.review_after || null, row.expires_at || null
                    ]
                );
                answerBankCount++;
            }
        }

        // 3. Upsert documents metadata
        if (Array.isArray(payload.documents)) {
            for (const row of payload.documents) {
                await db.run(
                    `INSERT INTO documents 
                     (document_id, filename, filepath, variant, tags, is_active, is_default, updated_at) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) 
                     ON CONFLICT(document_id) DO UPDATE SET 
                     filename = excluded.filename, filepath = excluded.filepath, variant = excluded.variant, is_active = excluded.is_active, is_default = excluded.is_default, updated_at = CURRENT_TIMESTAMP`,
                    [row.document_id, row.filename, row.filepath, row.variant || "default", row.tags || "[]", row.is_active ? 1 : 0, row.is_default ? 1 : 0]
                );
                documentsCount++;
            }
        }

        // 4. Upsert cover_letters
        if (Array.isArray(payload.cover_letters)) {
            for (const row of payload.cover_letters) {
                await db.run(
                    `INSERT INTO cover_letters 
                     (cover_letter_id, title, content, target_role, target_company, is_active, is_default, updated_at) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) 
                     ON CONFLICT(cover_letter_id) DO UPDATE SET 
                     title = excluded.title, content = excluded.content, target_role = excluded.target_role, target_company = excluded.target_company, is_active = excluded.is_active, is_default = excluded.is_default, updated_at = CURRENT_TIMESTAMP`,
                    [row.cover_letter_id, row.title, row.content, row.target_role || null, row.target_company || null, row.is_active ? 1 : 0, row.is_default ? 1 : 0]
                );
                coverLettersCount++;
            }
        }

        // Invalidate/refresh candidate profile runtime cache
        await candidateProfile.getProfile();

        return { profileCount, answerBankCount, documentsCount, coverLettersCount };
    }
}

module.exports = new CandidateKnowledgeSync();
