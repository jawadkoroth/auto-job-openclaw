const http = require("http");
const path = require("path");
const fs = require("fs-extra");
const logger = require("../logger").plugin("naukri");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const ORACLE_HOST = process.env.REMOTE_HOST || "140.245.212.88";
const ORACLE_PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3005;
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "openclaw2026";

class NaukriOraclePersistence {
    constructor() {
        this.outboxPath = path.join(process.cwd(), "sessions", "naukri", "naukri_pending_outbox.json");
        fs.mkdirpSync(path.dirname(this.outboxPath));
        this.authHeader = "Basic " + Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASSWORD}`).toString("base64");
    }

    _readOutbox() {
        if (fs.existsSync(this.outboxPath)) {
            try {
                return fs.readJsonSync(this.outboxPath) || [];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    _writeOutbox(items) {
        try {
            fs.writeJsonSync(this.outboxPath, items, { spaces: 2 });
        } catch (e) {
            logger.error(`Failed writing outbox file: ${e.message}`);
        }
    }

    _addToOutbox(type, data) {
        const outbox = this._readOutbox();
        outbox.push({
            id: `outbox_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: new Date().toISOString(),
            type,
            data
        });
        this._writeOutbox(outbox);
        logger.info(`📥 Saved outbox item [${type}] locally due to Oracle offline/unreachable state.`);
    }

    _makeRequest(method, apiPath, bodyData = null, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: ORACLE_HOST,
                port: ORACLE_PORT,
                path: apiPath,
                method: method.toUpperCase(),
                headers: {
                    "Authorization": this.authHeader,
                    "Content-Type": "application/json"
                },
                timeout: timeoutMs
            };

            const req = http.request(options, (res) => {
                let body = "";
                res.on("data", chunk => body += chunk);
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(body || "{}"));
                        } catch (e) {
                            resolve({});
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on("error", (err) => reject(err));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            });

            if (bodyData) {
                req.write(JSON.stringify(bodyData));
            }
            req.end();
        });
    }

    async flushOutbox() {
        const outbox = this._readOutbox();
        if (outbox.length === 0) return true;

        logger.info(`📤 Attempting to flush ${outbox.length} pending outbox item(s) to Oracle Persistence API...`);
        try {
            const payload = { items: outbox };
            const res = await this._makeRequest("POST", "/api/naukri/sync-outbox", payload, 10000);
            if (res && res.success) {
                logger.info(`✅ Successfully flushed ${res.processedCount || outbox.length} outbox item(s) to Oracle.`);
                this._writeOutbox([]);
                return true;
            }
        } catch (err) {
            logger.warn(`⚠️ Oracle outbox flush deferred: ${err.message}`);
        }
        return false;
    }

    async getDailyAppliedCount(dateStr) {
        await this.flushOutbox().catch(() => {});
        const date = dateStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        try {
            const res = await this._makeRequest("GET", `/api/naukri/daily-count?date=${encodeURIComponent(date)}`);
            if (res && res.success) {
                return res.count || 0;
            }
        } catch (err) {
            logger.warn(`⚠️ Failed to fetch Oracle daily count (${err.message}). Defaulting to 0.`);
        }
        return 0;
    }

    async isDuplicateJob(jobId, url) {
        // 1. Check local pending outbox first (immediate consistency)
        const outbox = this._readOutbox();
        const pendingInOutbox = outbox.some(item => {
            const d = item.data || {};
            return String(d.job_id) === String(jobId) || (url && d.url === url);
        });
        if (pendingInOutbox) {
            logger.info(`[Duplicate Check] Job ID ${jobId} found in local pending outbox. Treating as DUPLICATE.`);
            return true;
        }

        // 2. Query Oracle Persistence API
        try {
            const apiPath = `/api/naukri/job-status?jobId=${encodeURIComponent(jobId)}&url=${encodeURIComponent(url || "")}`;
            const res = await this._makeRequest("GET", apiPath);
            if (res && res.success && res.exists && res.job) {
                const appliedStatuses = [
                    "EMPLOYER_PENDING", "APPLICATION_SUBMITTED", "SHORTLISTED",
                    "WAITING_FOR_INPUT", "QUESTIONNAIRE_PENDING", "QUESTIONNAIRE_IN_PROGRESS", 
                    "QUESTIONNAIRE_SUBMITTED", "APPLIED", "ALREADY_APPLIED"
                ];
                if (res.job.applied === 1 || appliedStatuses.includes(res.job.status)) {
                    return true;
                }
            }
        } catch (err) {
            logger.warn(`⚠️ Failed querying Oracle for job duplicate status: ${err.message}`);
        }
        return false;
    }

    async recordJob(job) {
        const payload = {
            job_id: job.id || job.job_id,
            title: job.title,
            company: job.company,
            location: job.location,
            experience: job.experience,
            url: job.url,
            salary: job.salary
        };

        try {
            await this._makeRequest("POST", "/api/naukri/record-job", payload);
        } catch (err) {
            this._addToOutbox("RECORD_JOB", payload);
        }
    }

    async updateJobStatus(jobId, status, applied = null) {
        const payload = {
            job_id: jobId,
            status,
            applied
        };

        try {
            await this._makeRequest("POST", "/api/naukri/update-status", payload);
        } catch (err) {
            this._addToOutbox("UPDATE_STATUS", payload);
        }
    }

    async recordEvent(eventId, jobId, portal, eventType, payload) {
        const itemPayload = {
            event_id: eventId,
            job_id: jobId,
            portal: portal || "naukri",
            event_type: eventType,
            payload
        };

        try {
            await this._makeRequest("POST", "/api/naukri/record-event", itemPayload);
        } catch (err) {
            this._addToOutbox("RECORD_EVENT", itemPayload);
        }
    }
}

module.exports = new NaukriOraclePersistence();
