const sqlite3 = require("sqlite3").verbose();
const path = require("path");

class Database {
    constructor() {
        this.db = null;
        this.initPromise = null;
    }

    getDbPath() {
        return path.resolve(process.env.DATABASE_PATH || path.join(process.cwd(), "database.sqlite"));
    }

    /**
     * Connect to SQLite database file
     * @returns {Promise<import("sqlite3").Database>}
     */
    async connect() {
        if (this.db) return this.db;
        const targetPath = this.getDbPath();
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(targetPath, (err) => {
                if (err) return reject(err);
                resolve(this.db);
            });
        });
    }

    /**
     * Initialize relational table structures
     */
    async init() {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = (async () => {
            await this.connect();
            
            const rawRun = (sql, params = []) => new Promise((resolve, reject) => {
                this.db.run(sql, params, function(err) {
                    if (err) return reject(err);
                    resolve({ lastID: this.lastID, changes: this.changes });
                });
            });

            // Task queue table
            await rawRun(`
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    portal TEXT NOT NULL,
                    action TEXT NOT NULL,
                    args TEXT,
                    status TEXT DEFAULT 'pending',
                    attempts INTEGER DEFAULT 0,
                    result TEXT,
                    error TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Deduplicated scraped jobs table
            await rawRun(`
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    portal TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    company TEXT,
                    title TEXT,
                    location TEXT,
                    experience TEXT,
                    salary TEXT,
                    applied INTEGER DEFAULT 0,
                    ignored INTEGER DEFAULT 0,
                    reason TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(portal, job_id)
                )
            `);
            // Safe migration step for existing databases
            await rawRun("ALTER TABLE jobs ADD COLUMN experience TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN url TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN status TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN external_url TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN ats TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN job_description TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN pending_question TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN pending_suggested_answer TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN pending_question_id TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN approval_id TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN ai_content_prohibited INTEGER DEFAULT 0").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN intermediary_platform TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN intermediary_url TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN final_application_url TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN routing_status TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN application_method TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN conversation_id TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN last_employer_message TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN last_questionnaire_at DATETIME").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN questionnaire_status TEXT").catch(() => {});
            await rawRun("ALTER TABLE jobs ADD COLUMN updated_at DATETIME").catch(() => {});

            // Create Q&A memory table
            await rawRun(`
                CREATE TABLE IF NOT EXISTS qna_memory (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question_normalized TEXT UNIQUE NOT NULL,
                    question_raw TEXT,
                    answer TEXT NOT NULL,
                    answer_type TEXT,
                    source TEXT,
                    confidence TEXT,
                    approved INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Isolated session audit logs
            await rawRun(`
                CREATE TABLE IF NOT EXISTS session_metadata (
                    portal TEXT PRIMARY KEY,
                    last_login TEXT,
                    cookie_age INTEGER,
                    last_refresh TEXT,
                    profile_updated TEXT,
                    resume_uploaded TEXT,
                    browser_version TEXT,
                    session_health TEXT
                )
            `);

            // Candidate Profile store
            await rawRun(`
                CREATE TABLE IF NOT EXISTS candidate_profile (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    category TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Application Answer Bank
            await rawRun(`
                CREATE TABLE IF NOT EXISTS answer_bank (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_key TEXT NOT NULL,
                    original_question TEXT NOT NULL,
                    normalized_question TEXT UNIQUE NOT NULL,
                    approved_answer TEXT NOT NULL,
                    answer_type TEXT DEFAULT 'FACTUAL',
                    is_sensitive INTEGER DEFAULT 0,
                    auto_use_enabled INTEGER DEFAULT 1,
                    confidence_threshold REAL DEFAULT 0.8,
                    usage_count INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    review_after DATETIME,
                    expires_at DATETIME
                )
            `);

            // Document Manager (Resumes/CVs)
            await rawRun(`
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id TEXT UNIQUE NOT NULL,
                    filename TEXT NOT NULL,
                    filepath TEXT NOT NULL,
                    variant TEXT DEFAULT 'default',
                    tags TEXT,
                    is_active INTEGER DEFAULT 1,
                    is_default INTEGER DEFAULT 0,
                    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Cover Letter Manager
            await rawRun(`
                CREATE TABLE IF NOT EXISTS cover_letters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cover_letter_id TEXT UNIQUE NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    target_role TEXT,
                    target_company TEXT,
                    is_active INTEGER DEFAULT 1,
                    is_default INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Application Snapshots
            await rawRun(`
                CREATE TABLE IF NOT EXISTS application_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    candidate_profile_snapshot TEXT,
                    resume_document_id TEXT,
                    cover_letter_id TEXT,
                    answer_bank_ids_used TEXT,
                    one_time_answers_used TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Normalized Conversations Table
            await rawRun(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT UNIQUE NOT NULL,
                    portal TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    company TEXT,
                    recruiter_name TEXT,
                    conversation_status TEXT DEFAULT 'CONVERSATION_CREATED',
                    last_message TEXT,
                    last_message_at DATETIME,
                    last_checked_at DATETIME,
                    questionnaire_status TEXT,
                    needs_attention INTEGER DEFAULT 0,
                    waiting_for_input INTEGER DEFAULT 0,
                    interview_requested INTEGER DEFAULT 0,
                    coding_test_requested INTEGER DEFAULT 0,
                    offer_received INTEGER DEFAULT 0,
                    closed INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Employer Knowledge Intelligence Store
            await rawRun(`
                CREATE TABLE IF NOT EXISTS employer_knowledge (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    company_name TEXT NOT NULL,
                    portal TEXT NOT NULL,
                    recruiter_name TEXT,
                    question_patterns TEXT,
                    common_questionnaire TEXT,
                    expected_notice_question TEXT,
                    expected_salary_question TEXT,
                    coding_test_provider TEXT,
                    interview_process TEXT,
                    average_response_days INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(portal, company_name)
                )
            `);

            // Application Lifecycle Event History Table
            await rawRun(`
                CREATE TABLE IF NOT EXISTS application_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE NOT NULL,
                    job_id TEXT NOT NULL,
                    conversation_id TEXT,
                    portal TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
        })();

        return this.initPromise;
    }

    /**
     * Execute a write query (INSERT/UPDATE/DELETE)
     * @param {string} sql 
     * @param {any[]} params 
     */
    async run(sql, params = []) {
        await this.init().catch(() => {});
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    /**
     * Fetch a single row
     * @param {string} sql 
     * @param {any[]} params 
     */
    async get(sql, params = []) {
        await this.init().catch(() => {});
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });
    }

    /**
     * Fetch all rows matching query criteria
     * @param {string} sql 
     * @param {any[]} params 
     */
    async all(sql, params = []) {
        await this.init().catch(() => {});
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    normalizeQuestion(text) {
        if (!text) return "";
        return String(text).toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    }

    generatePendingQuestionId(jobId, questionText) {
        const norm = this.normalizeQuestion(questionText);
        return `${jobId}_${norm}`;
    }

    generateApprovalId(portal, jobId, questionText) {
        const crypto = require("crypto");
        const norm = this.normalizeQuestion(questionText);
        const hash = crypto.createHash("md5").update(norm || "default").digest("hex").slice(0, 6);
        const cleanPortal = (portal || "job").toLowerCase().replace(/[^a-z0-9]/g, "");
        const cleanJobId = String(jobId || "0").replace(/[^a-z0-9_-]/gi, "");
        return `${cleanPortal}-${cleanJobId}-${hash}`;
    }

    async getUnresolvedPendingQuestion(portal, jobId, questionText) {
        const pendingQuestionId = this.generatePendingQuestionId(jobId, questionText);
        const approvalId = this.generateApprovalId(portal, jobId, questionText);
        const norm = this.normalizeQuestion(questionText);

        const row = await this.get(
            `SELECT * FROM jobs 
             WHERE (id = ? OR job_id = ?) 
               AND status = 'WAITING_FOR_INPUT' 
               AND (pending_question_id = ? OR approval_id = ? OR LOWER(REPLACE(REPLACE(pending_question, ' ', ''), '?', '')) = ?)`,
            [jobId, jobId, pendingQuestionId, approvalId, norm]
        );
        return row || null;
    }

    /**
     * Check if job is a duplicate across active application statuses (Fix 8)
     * Active statuses: EXTERNAL_PENDING, EXTERNAL_IN_PROGRESS, WAITING_FOR_INPUT, READY_TO_RESUME, CLICKED_UNVERIFIED, APPLIED
     */
    async isDuplicateJob(portal, jobId) {
        await this.init().catch(() => {});
        const activeStatuses = [
            "DISCOVERED", "APPLY_STARTED", "CONVERSATION_CREATED", 
            "QUESTIONNAIRE_PENDING", "QUESTIONNAIRE_IN_PROGRESS", "QUESTIONNAIRE_SUBMITTED", 
            "APPLICATION_SUBMITTED", "EMPLOYER_PENDING", "SHORTLISTED",
            "EXTERNAL_PENDING", "EXTERNAL_IN_PROGRESS", "WAITING_FOR_INPUT", 
            "READY_TO_RESUME", "CLICKED_UNVERIFIED", "APPLIED", "ALREADY_APPLIED"
        ];
        const placeholders = activeStatuses.map(() => "?").join(",");
        const row = await this.get(
            `SELECT * FROM jobs WHERE portal = ? AND (job_id = ? OR id = ?) AND status IN (${placeholders})`,
            [portal, String(jobId), String(jobId), ...activeStatuses]
        );
        return Boolean(row);
    }

    /**
     * Gracefully close SQLite database connection
     */
    async close() {
        if (this.db) {
            return new Promise((resolve, reject) => {
                this.db.close((err) => {
                    if (err) return reject(err);
                    this.db = null;
                    this.initPromise = null;
                    resolve();
                });
            });
        }
    }
}

const db = new Database();
// Trigger non-blocking init sequence
db.init().catch(err => console.error("Database initialization failed:", err));

module.exports = db;
