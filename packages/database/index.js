const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(process.cwd(), "database.sqlite");

class Database {
    constructor() {
        this.db = null;
        this.initPromise = null;
    }

    /**
     * Connect to SQLite database file
     * @returns {Promise<import("sqlite3").Database>}
     */
    async connect() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(dbPath, (err) => {
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
            
            // Task queue table
            await this.run(`
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
            await this.run(`
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    portal TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    company TEXT,
                    title TEXT,
                    location TEXT,
                    salary TEXT,
                    applied INTEGER DEFAULT 0,
                    ignored INTEGER DEFAULT 0,
                    reason TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(portal, job_id)
                )
            `);

            // Isolated session audit logs
            await this.run(`
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
        })();

        return this.initPromise;
    }

    /**
     * Execute a write query (INSERT/UPDATE/DELETE)
     * @param {string} sql 
     * @param {any[]} params 
     */
    run(sql, params = []) {
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
    get(sql, params = []) {
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
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
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
