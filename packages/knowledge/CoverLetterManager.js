const db = require("../database");

class CoverLetterManager {
    /**
     * Get best matching cover letter based on priority:
     * Company-specific -> Role-specific -> Default
     * @param {Object} params 
     * @returns {Promise<{ found: boolean, content?: string, coverLetterId?: string, title?: string }>}
     */
    async getBestCoverLetter({ company = "", role = "" } = {}) {
        await db.init().catch(() => {});

        // 1. Company-specific
        if (company) {
            const compMatch = await db.get(
                "SELECT * FROM cover_letters WHERE LOWER(target_company) = LOWER(?) AND is_active = 1 ORDER BY updated_at DESC",
                [company.trim()]
            ).catch(() => null);
            if (compMatch) {
                return { found: true, content: compMatch.content, coverLetterId: compMatch.cover_letter_id, title: compMatch.title };
            }
        }

        // 2. Role-specific
        if (role) {
            const roleMatch = await db.get(
                "SELECT * FROM cover_letters WHERE LOWER(target_role) = LOWER(?) AND is_active = 1 ORDER BY updated_at DESC",
                [role.trim()]
            ).catch(() => null);
            if (roleMatch) {
                return { found: true, content: roleMatch.content, coverLetterId: roleMatch.cover_letter_id, title: roleMatch.title };
            }
        }

        // 3. Default active cover letter
        const defMatch = await db.get(
            "SELECT * FROM cover_letters WHERE is_default = 1 AND is_active = 1 ORDER BY updated_at DESC"
        ).catch(() => null);
        if (defMatch) {
            return { found: true, content: defMatch.content, coverLetterId: defMatch.cover_letter_id, title: defMatch.title };
        }

        return { found: false };
    }

    async saveCoverLetter({ title, content, targetRole = null, targetCompany = null, isDefault = false }) {
        await db.init().catch(() => {});
        const coverLetterId = `cl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        if (isDefault) {
            await db.run("UPDATE cover_letters SET is_default = 0").catch(() => {});
        }

        await db.run(
            `INSERT INTO cover_letters (cover_letter_id, title, content, target_role, target_company, is_active, is_default) 
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
            [coverLetterId, title, content, targetRole, targetCompany, isDefault ? 1 : 0]
        );

        return coverLetterId;
    }

    async updateCoverLetter(id, updates) {
        await db.init().catch(() => {});
        const fields = [];
        const values = [];

        if (updates.title !== undefined) {
            fields.push("title = ?");
            values.push(updates.title);
        }
        if (updates.content !== undefined) {
            fields.push("content = ?");
            values.push(updates.content);
        }
        if (updates.targetRole !== undefined) {
            fields.push("target_role = ?");
            values.push(updates.targetRole);
        }
        if (updates.targetCompany !== undefined) {
            fields.push("target_company = ?");
            values.push(updates.targetCompany);
        }
        if (updates.isActive !== undefined) {
            fields.push("is_active = ?");
            values.push(updates.isActive ? 1 : 0);
        }
        if (updates.isDefault !== undefined) {
            if (updates.isDefault) {
                await db.run("UPDATE cover_letters SET is_default = 0").catch(() => {});
            }
            fields.push("is_default = ?");
            values.push(updates.isDefault ? 1 : 0);
        }

        if (fields.length === 0) return;

        fields.push("updated_at = CURRENT_TIMESTAMP");
        values.push(id);

        await db.run(`UPDATE cover_letters SET ${fields.join(", ")} WHERE id = ? OR cover_letter_id = ?`, [...values, id]);
    }

    async setDefault(id) {
        await db.init().catch(() => {});
        await db.run("UPDATE cover_letters SET is_default = 0").catch(() => {});
        await db.run("UPDATE cover_letters SET is_default = 1, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR cover_letter_id = ?", [id, id]);
    }

    async deleteCoverLetter(id) {
        await db.init().catch(() => {});
        await db.run("DELETE FROM cover_letters WHERE id = ? OR cover_letter_id = ?", [id, id]);
    }

    async getAllCoverLetters() {
        await db.init().catch(() => {});
        return await db.all("SELECT * FROM cover_letters ORDER BY is_default DESC, updated_at DESC").catch(() => []);
    }
}

module.exports = new CoverLetterManager();
