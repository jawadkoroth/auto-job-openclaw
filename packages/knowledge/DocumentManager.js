const db = require("../database");
const resumeManager = require("../resume/ResumeManager");
const path = require("path");
const fs = require("fs-extra");

class DocumentManager {
    constructor() {
        this.resumeDir = path.join(process.cwd(), "resumes");
        fs.ensureDirSync(this.resumeDir);
    }

    /**
     * Get the single default active production CV
     * @returns {Promise<{ filePath: string, documentId: string, variant: string, filename: string }>}
     */
    async getDefaultResume() {
        await db.init().catch(() => {});

        // 1. Fetch active default CV from DB
        const defaultDoc = await db.get(
            "SELECT * FROM documents WHERE is_default = 1 AND is_active = 1 ORDER BY updated_at DESC"
        ).catch(() => null);

        if (defaultDoc && fs.existsSync(defaultDoc.filepath)) {
            return {
                filePath: defaultDoc.filepath,
                documentId: defaultDoc.document_id,
                variant: defaultDoc.variant || "default",
                filename: defaultDoc.filename
            };
        }

        // 2. Fallback to any active CV in DB
        const anyActiveDoc = await db.get(
            "SELECT * FROM documents WHERE is_active = 1 ORDER BY is_default DESC, updated_at DESC"
        ).catch(() => null);

        if (anyActiveDoc && fs.existsSync(anyActiveDoc.filepath)) {
            return {
                filePath: anyActiveDoc.filepath,
                documentId: anyActiveDoc.document_id,
                variant: anyActiveDoc.variant || "default",
                filename: anyActiveDoc.filename
            };
        }

        // 3. Fallback to ResumeManager file system lookup
        const fallbackPath = await resumeManager.getResumePath("foundit", "default");
        const docId = `doc_${path.basename(fallbackPath, ".pdf")}`;
        return {
            filePath: fallbackPath,
            documentId: docId,
            variant: "default",
            filename: path.basename(fallbackPath)
        };
    }

    /**
     * Get best matching resume (forces single default CV for production consistency)
     */
    async getBestResume() {
        return this.getDefaultResume();
    }

    /**
     * Upload and set a new Default CV PDF
     * @param {string} filename 
     * @param {Buffer} buffer 
     * @returns {Promise<string>} documentId
     */
    async uploadDefaultCv(filename, buffer) {
        await db.init().catch(() => {});

        // Validate PDF signature
        if (!buffer || buffer.length < 4 || buffer.toString("utf8", 0, 4) !== "%PDF") {
            throw new Error("Invalid document format. File must be a valid PDF.");
        }

        const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const targetPath = path.join(this.resumeDir, safeFilename);

        await fs.writeFile(targetPath, buffer);

        const documentId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // Set all existing documents to inactive & non-default
        await db.run("UPDATE documents SET is_default = 0, is_active = 0").catch(() => {});

        // Insert new document as active default
        await db.run(
            `INSERT INTO documents (document_id, filename, filepath, variant, tags, is_active, is_default, uploaded_at, updated_at) 
             VALUES (?, ?, ?, 'default', '["default"]', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [documentId, safeFilename, targetPath]
        );

        return documentId;
    }

    /**
     * Set a specific document as default (archives others)
     */
    async setDefault(documentId) {
        await db.init().catch(() => {});
        await db.run("UPDATE documents SET is_default = 0, is_active = 0").catch(() => {});
        await db.run("UPDATE documents SET is_default = 1, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE document_id = ?", [documentId]);
    }

    /**
     * Delete or archive a document safely
     * If referenced in snapshots, archive (is_active = 0, is_default = 0).
     * If not referenced, delete record and file.
     */
    async deleteDocument(documentId) {
        await db.init().catch(() => {});
        const doc = await db.get("SELECT * FROM documents WHERE document_id = ? OR id = ?", [documentId, documentId]);
        if (!doc) return;

        // Check if referenced in application_snapshots
        const snapshotRef = await db.get(
            "SELECT id FROM application_snapshots WHERE resume_document_id = ? OR resume_document_id = ?",
            [doc.document_id, doc.filename]
        ).catch(() => null);

        if (snapshotRef) {
            // Archive document to preserve immutable historical snapshot reference
            await db.run("UPDATE documents SET is_active = 0, is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE document_id = ?", [doc.document_id]);
        } else {
            await db.run("DELETE FROM documents WHERE document_id = ?", [doc.document_id]);
            if (fs.existsSync(doc.filepath)) {
                await fs.remove(doc.filepath).catch(() => {});
            }
        }
    }

    /**
     * Clean up test records (e.g. resume_test.pdf) safely
     */
    async purgeTestRecords() {
        await db.init().catch(() => {});
        const testDocs = await db.all(
            "SELECT * FROM documents WHERE filename LIKE '%test%' OR filename LIKE '%devops_test%'"
        ).catch(() => []);

        for (const doc of testDocs) {
            await this.deleteDocument(doc.document_id);
        }
    }

    async getAllDocuments() {
        await db.init().catch(() => {});
        await this.purgeTestRecords().catch(() => {});
        return await db.all("SELECT * FROM documents ORDER BY is_default DESC, updated_at DESC").catch(() => []);
    }
}

module.exports = new DocumentManager();
