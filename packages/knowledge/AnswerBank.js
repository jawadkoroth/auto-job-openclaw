const db = require("../database");

class AnswerBank {
    normalize(text) {
        if (!text) return "";
        return String(text).toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    }

    /**
     * Map common question phrases to canonical keys
     * @param {string} question 
     * @returns {string|null}
     */
    getCanonicalKey(question) {
        const q = this.normalize(question);
        if (!q) return null;

        if (q.includes("gcp") || q.includes("googlecloud")) return "experience_gcp";
        if (q.includes("aws") || q.includes("amazonweb")) return "experience_aws";
        if (q.includes("azure")) return "experience_azure";
        if (q.includes("kubernetes") || q.includes("k8s")) return "experience_kubernetes";
        if (q.includes("devops")) return "experience_devops";
        if (q.includes("docker")) return "experience_docker";
        if (q.includes("notice") || q.includes("howsoon") || q.includes("startdate")) return "notice_period";
        if (q.includes("workauth") || q.includes("authorizedtowork") || q.includes("legallyauthorized")) return "work_authorization";
        if (q.includes("sponsorship") || q.includes("visasponsorship") || q.includes("requirevisa")) return "visa_sponsorship";
        if (q.includes("relocate") || q.includes("relocation")) return "relocation_preference";
        if (q.includes("expectedsalary") || q.includes("salaryexpectation") || q.includes("compensation")) return "salary_expectation";
        if (q.includes("disability") || q.includes("disabled")) return "demographic_disability";
        if (q.includes("veteran") || q.includes("military")) return "demographic_veteran";
        if (q.includes("gender") || q.includes("sex")) return "demographic_gender";
        if (q.includes("race") || q.includes("ethnicity")) return "demographic_race";

        return null;
    }

    /**
     * Search Answer Bank for matching answer
     * @param {string} question 
     * @param {Object} options
     * @returns {Promise<{ found: boolean, answer?: string, entry?: Object, conflict?: boolean, isStale?: boolean, reason?: string }>}
     */
    async findAnswer(question, options = {}) {
        await db.init().catch(() => {});
        const norm = this.normalize(question);
        const canonicalKey = options.canonicalKey || this.getCanonicalKey(question);

        // Check canonical key conflicts first if key exists
        if (canonicalKey) {
            const matches = await db.all("SELECT * FROM answer_bank WHERE canonical_key = ?", [canonicalKey]).catch(() => []);
            if (matches.length > 0) {
                const uniqueAnswers = Array.from(new Set(matches.map(m => m.approved_answer.trim())));
                if (uniqueAnswers.length > 1) {
                    return { found: false, conflict: true, reason: "CONFLICTING_SAVED_ANSWERS", options: matches };
                }
            }
        }

        // Exact normalized match
        const exact = await db.get("SELECT * FROM answer_bank WHERE normalized_question = ?", [norm]).catch(() => null);
        if (exact) {
            if (exact.auto_use_enabled === 0) {
                return { found: false, reason: "AUTO_USE_DISABLED", entry: exact };
            }
            const isStale = exact.review_after && new Date(exact.review_after) < new Date();
            await this.incrementUsage(exact.id);
            return { found: true, answer: exact.approved_answer, entry: exact, isStale: Boolean(isStale) };
        }

        // Canonical key lookup
        if (canonicalKey) {
            const matches = await db.all("SELECT * FROM answer_bank WHERE canonical_key = ?", [canonicalKey]).catch(() => []);
            if (matches.length > 0) {
                const best = matches[0];
                if (best.auto_use_enabled === 0) {
                    return { found: false, reason: "AUTO_USE_DISABLED", entry: best };
                }
                const isStale = best.review_after && new Date(best.review_after) < new Date();
                await this.incrementUsage(best.id);
                return { found: true, answer: best.approved_answer, entry: best, isStale: Boolean(isStale) };
            }
        }

        return { found: false };
    }

    /**
     * Add or update an answer in the Answer Bank
     * @param {Object} entry 
     */
    async saveAnswer({ canonicalKey, question, answer, answerType = "FACTUAL", isSensitive = 0, autoUseEnabled = 1, reviewAfter = null }) {
        await db.init().catch(() => {});
        const norm = this.normalize(question);
        const key = canonicalKey || this.getCanonicalKey(question) || `custom_${norm.slice(0, 20)}`;

        const existing = await db.get("SELECT id FROM answer_bank WHERE normalized_question = ?", [norm]).catch(() => null);
        if (existing) {
            await db.run(
                `UPDATE answer_bank 
                 SET approved_answer = ?, canonical_key = ?, answer_type = ?, is_sensitive = ?, auto_use_enabled = ?, review_after = ?, updated_at = CURRENT_TIMESTAMP 
                 WHERE id = ?`,
                [answer, key, answerType, isSensitive ? 1 : 0, autoUseEnabled ? 1 : 0, reviewAfter, existing.id]
            );
            return existing.id;
        } else {
            const res = await db.run(
                `INSERT INTO answer_bank (canonical_key, original_question, normalized_question, approved_answer, answer_type, is_sensitive, auto_use_enabled, review_after) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [key, question, norm, answer, answerType, isSensitive ? 1 : 0, autoUseEnabled ? 1 : 0, reviewAfter]
            );
            return res.lastID;
        }
    }

    async incrementUsage(id) {
        await db.run("UPDATE answer_bank SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [id]).catch(() => {});
    }

    async getAllAnswers() {
        await db.init().catch(() => {});
        return await db.all("SELECT * FROM answer_bank ORDER BY updated_at DESC").catch(() => []);
    }

    async updateAnswer(id, updates) {
        await db.init().catch(() => {});
        const fields = [];
        const values = [];

        if (updates.question !== undefined) {
            fields.push("original_question = ?");
            values.push(updates.question);
            fields.push("normalized_question = ?");
            values.push(this.normalize(updates.question));
        }
        if (updates.canonicalKey !== undefined) {
            fields.push("canonical_key = ?");
            values.push(updates.canonicalKey);
        }
        if (updates.answer !== undefined) {
            fields.push("approved_answer = ?");
            values.push(updates.answer);
        }
        if (updates.answerType !== undefined) {
            fields.push("answer_type = ?");
            values.push(updates.answerType);
        }
        if (updates.isSensitive !== undefined) {
            fields.push("is_sensitive = ?");
            values.push(updates.isSensitive ? 1 : 0);
        }
        if (updates.autoUseEnabled !== undefined) {
            fields.push("auto_use_enabled = ?");
            values.push(updates.autoUseEnabled ? 1 : 0);
        }
        if (updates.reviewAfter !== undefined) {
            fields.push("review_after = ?");
            values.push(updates.reviewAfter);
        }
        if (updates.expiresAt !== undefined) {
            fields.push("expires_at = ?");
            values.push(updates.expiresAt);
        }

        if (fields.length === 0) return;

        fields.push("updated_at = CURRENT_TIMESTAMP");
        values.push(id);

        await db.run(`UPDATE answer_bank SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    async deleteAnswer(id) {
        await db.init().catch(() => {});
        await db.run("DELETE FROM answer_bank WHERE id = ?", [id]);
    }
}

module.exports = new AnswerBank();
