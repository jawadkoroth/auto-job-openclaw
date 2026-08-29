/**
 * Observability Storage Manager
 * Handles artifact file structures on disk and SQLite persistence.
 */

const path = require("path");
const fs = require("fs-extra");
const db = require("../database");
const sanitizer = require("./SensitiveDataSanitizer");

class ObservabilityStorage {
    constructor() {
        this.basePath = path.join(process.cwd(), "sessions", "observability");
        try {
            fs.ensureDirSync(this.basePath);
        } catch (e) {}
    }

    /**
     * Get directory path for a specific run
     * @param {string} portal 
     * @param {string} runId 
     * @param {string} [dateStr] YYYY-MM-DD
     * @returns {string}
     */
    getRunDir(portal, runId, dateStr = null) {
        const d = dateStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const cleanPortal = (portal || "generic").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        const dir = path.join(this.basePath, d, cleanPortal, runId);
        fs.ensureDirSync(dir);
        return dir;
    }

    /**
     * Get directory path for a specific job under a run
     * @param {string} portal 
     * @param {string} runId 
     * @param {string} jobId 
     * @param {string} [dateStr] 
     * @returns {string}
     */
    getJobDir(portal, runId, jobId, dateStr = null) {
        const runDir = this.getRunDir(portal, runId, dateStr);
        const cleanJobId = String(jobId || "unknown").replace(/[^a-z0-9_-]/gi, "");
        const jobDir = path.join(runDir, "jobs", cleanJobId);
        fs.ensureDirSync(jobDir);
        fs.ensureDirSync(path.join(jobDir, "screenshots"));
        fs.ensureDirSync(path.join(jobDir, "network"));
        return jobDir;
    }

    getJobArtifactDir(runId, portal, jobId, dateStr = null) {
        return this.getJobDir(portal, runId, jobId, dateStr);
    }

    /**
     * Save run metadata JSON to disk
     * @param {string} runDir 
     * @param {Object} data 
     */
    async saveRunJson(runDir, data) {
        try {
            const filePath = path.join(runDir, "run.json");
            await fs.writeJson(filePath, sanitizer.sanitizeData(data), { spaces: 2 });
        } catch (e) {}
    }

    /**
     * Append to run.log
     * @param {string} runDir 
     * @param {string} message 
     */
    async appendRunLog(runDir, message) {
        try {
            const filePath = path.join(runDir, "run.log");
            const entry = `[${new Date().toISOString()}] ${sanitizer.sanitizeString(message)}\n`;
            await fs.appendFile(filePath, entry);
        } catch (e) {}
    }

    /**
     * Save job attempt metadata
     * @param {string} jobDir 
     * @param {string} fileName 
     * @param {Object} data 
     */
    async saveJobJson(jobDir, fileName, data) {
        try {
            const filePath = path.join(jobDir, fileName);
            await fs.writeJson(filePath, sanitizer.sanitizeData(data), { spaces: 2 });
        } catch (e) {}
    }

    /**
     * Persist automation run to SQLite
     * @param {Object} runData 
     */
    async persistRun(runData) {
        try {
            await db.init();
            const {
                runId,
                portal,
                action,
                workerId,
                taskId,
                status,
                triggerType,
                discoveredCount = 0,
                eligibleCount = 0,
                selectedCount = 0,
                attemptsCount = 0,
                verifiedAppliedCount = 0,
                pendingVerificationCount = 0,
                clickedUnverifiedCount = 0,
                waitingInputCount = 0,
                failedCount = 0,
                zeroReason = null,
                startedAt,
                finishedAt = null,
                durationMs = 0,
                summaryJson = {}
            } = runData;

            const existing = await db.get("SELECT run_id FROM automation_runs WHERE run_id = ?", [runId]);
            if (existing) {
                await db.run(
                    `UPDATE automation_runs SET
                        status = ?,
                        discovered_count = ?,
                        eligible_count = ?,
                        selected_count = ?,
                        attempts_count = ?,
                        verified_applied_count = ?,
                        pending_verification_count = ?,
                        clicked_unverified_count = ?,
                        waiting_input_count = ?,
                        failed_count = ?,
                        zero_reason = ?,
                        finished_at = ?,
                        duration_ms = ?,
                        summary_json = ?
                     WHERE run_id = ?`,
                    [
                        status,
                        discoveredCount,
                        eligibleCount,
                        selectedCount,
                        attemptsCount,
                        verifiedAppliedCount,
                        pendingVerificationCount,
                        clickedUnverifiedCount,
                        waitingInputCount,
                        failedCount,
                        zeroReason,
                        finishedAt,
                        durationMs,
                        JSON.stringify(sanitizer.sanitizeData(summaryJson)),
                        runId
                    ]
                );
            } else {
                await db.run(
                    `INSERT INTO automation_runs (
                        run_id, portal, action, worker_id, task_id, status, trigger_type,
                        discovered_count, eligible_count, selected_count, attempts_count,
                        verified_applied_count, pending_verification_count, clicked_unverified_count,
                        waiting_input_count, failed_count, zero_reason, started_at, finished_at,
                        duration_ms, summary_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        runId,
                        (portal || "generic").toLowerCase(),
                        action || "apply",
                        workerId || "oracle",
                        taskId || null,
                        status || "RUNNING",
                        triggerType || "SCHEDULED",
                        discoveredCount,
                        eligibleCount,
                        selectedCount,
                        attemptsCount,
                        verifiedAppliedCount,
                        pendingVerificationCount,
                        clickedUnverifiedCount,
                        waitingInputCount,
                        failedCount,
                        zeroReason,
                        startedAt || new Date().toISOString(),
                        finishedAt,
                        durationMs,
                        JSON.stringify(sanitizer.sanitizeData(summaryJson))
                    ]
                );
            }
        } catch (err) {
            console.error(`[ObservabilityStorage] persistRun error: ${err.message}`);
        }
    }

    /**
     * Persist application attempt record to SQLite
     * @param {Object} attemptData 
     */
    async persistApplicationAttempt(attemptData) {
        try {
            await db.init();
            const {
                attemptId,
                runId,
                taskId,
                portal,
                jobId,
                company,
                title,
                location,
                experience,
                applyType,
                workerId,
                startedAt,
                completedAt,
                verdict,
                verificationLevel,
                applicationId,
                sourceUrl,
                destinationUrl,
                ats,
                errorCode,
                errorMessage
            } = attemptData;

            const existing = await db.get("SELECT attempt_id FROM application_attempts WHERE attempt_id = ?", [attemptId]);
            if (existing) {
                await db.run(
                    `UPDATE application_attempts SET
                        completed_at = ?,
                        verdict = ?,
                        verification_level = ?,
                        application_id = ?,
                        destination_url = ?,
                        ats = ?,
                        error_code = ?,
                        error_message = ?
                     WHERE attempt_id = ?`,
                    [
                        completedAt,
                        verdict,
                        verificationLevel,
                        applicationId,
                        destinationUrl,
                        ats,
                        errorCode,
                        errorMessage,
                        attemptId
                    ]
                );
            } else {
                await db.run(
                    `INSERT INTO application_attempts (
                        attempt_id, run_id, task_id, portal, job_id, company, title,
                        location, experience, apply_type, worker_id, started_at, completed_at,
                        verdict, verification_level, application_id, source_url, destination_url,
                        ats, error_code, error_message
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        attemptId,
                        runId,
                        taskId,
                        portal,
                        String(jobId),
                        company,
                        title,
                        location,
                        experience,
                        applyType || "NATIVE",
                        workerId || "oracle",
                        startedAt || new Date().toISOString(),
                        completedAt,
                        verdict || "IN_PROGRESS",
                        verificationLevel || "NONE",
                        applicationId,
                        sourceUrl,
                        destinationUrl,
                        ats,
                        errorCode,
                        errorMessage
                    ]
                );
            }
        } catch (err) {
            console.error(`[ObservabilityStorage] persistApplicationAttempt error: ${err.message}`);
        }
    }

    /**
     * Persist application evidence file / item
     * @param {Object} evidenceData 
     */
    async persistEvidence(evidenceData) {
        try {
            await db.init();
            const { attemptId, runId, jobId, evidenceType, filePath, dataJson } = evidenceData;
            await db.run(
                `INSERT INTO application_evidence (
                    attempt_id, run_id, job_id, evidence_type, file_path, data_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    attemptId,
                    runId,
                    String(jobId || ""),
                    evidenceType,
                    filePath || null,
                    dataJson ? JSON.stringify(sanitizer.sanitizeData(dataJson)) : null
                ]
            );
        } catch (err) {
            console.error(`[ObservabilityStorage] persistEvidence error: ${err.message}`);
        }
    }

    /**
     * Persist worker event record
     * @param {Object} eventData 
     */
    async persistWorkerEvent(eventData) {
        try {
            await db.init();
            const { workerId, eventType, runId, taskId, payload } = eventData;
            await db.run(
                `INSERT INTO worker_events (
                    worker_id, event_type, run_id, task_id, payload, timestamp
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    workerId,
                    eventType,
                    runId || null,
                    taskId || null,
                    payload ? JSON.stringify(sanitizer.sanitizeData(payload)) : null
                ]
            );
        } catch (err) {}
    }

    /**
     * Diagnostic Query: Latest run summary for portal or all
     * @param {string} [portal] 
     * @returns {Promise<Object|null>}
     */
    async getLatestRun(portal = null) {
        await db.init();
        let row;
        if (portal && portal !== "all") {
            row = await db.get(
                "SELECT * FROM automation_runs WHERE LOWER(portal) = ? ORDER BY started_at DESC LIMIT 1",
                [portal.toLowerCase()]
            );
        } else {
            row = await db.get(
                "SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 1"
            );
        }
        if (row && row.summary_json) {
            try { row.summary = JSON.parse(row.summary_json); } catch (e) {}
        }
        return row || null;
    }

    /**
     * Diagnostic Query: Recent runs list
     * @param {number} [limit=10] 
     * @returns {Promise<Array>}
     */
    async getRecentRuns(limit = 10) {
        await db.init();
        const rows = await db.all(
            "SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?",
            [limit]
        );
        return rows.map(r => {
            if (r.summary_json) {
                try { r.summary = JSON.parse(r.summary_json); } catch (e) {}
            }
            return r;
        });
    }

    /**
     * Diagnostic Query: Job application details by Job ID
     * @param {string} jobId 
     * @returns {Promise<{ attempts: Array, events: Array, evidence: Array }>}
     */
    async getJobApplicationDetails(jobId) {
        await db.init();
        const idStr = String(jobId);
        const attempts = await db.all(
            "SELECT * FROM application_attempts WHERE job_id = ? ORDER BY started_at DESC",
            [idStr]
        );
        const events = await db.all(
            "SELECT * FROM application_events WHERE job_id = ? ORDER BY timestamp DESC",
            [idStr]
        );
        const evidence = await db.all(
            "SELECT * FROM application_evidence WHERE job_id = ? ORDER BY created_at DESC",
            [idStr]
        );
        return { attempts, events, evidence };
    }

    /**
     * Diagnostic Query: Run details by Run ID
     * @param {string} runId 
     */
    async getRunDetails(runId) {
        await db.init();
        const run = await db.get("SELECT * FROM automation_runs WHERE run_id = ?", [runId]);
        if (!run) return null;
        if (run.summary_json) {
            try { run.summary = JSON.parse(run.summary_json); } catch (e) {}
        }
        const attempts = await db.all(
            "SELECT * FROM application_attempts WHERE run_id = ? ORDER BY started_at ASC",
            [runId]
        );
        const workerEvents = await db.all(
            "SELECT * FROM worker_events WHERE run_id = ? ORDER BY timestamp ASC",
            [runId]
        );
        return { run, attempts, workerEvents };
    }

    /**
     * Diagnostic Query: Get comprehensive daily summary for a date (default: today IST)
     * @param {string} [dateStr] YYYY-MM-DD
     * @returns {Promise<Object>}
     */
    async getDailySummary(dateStr = null) {
        await db.init();
        const targetDate = dateStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const runs = await db.all(
            "SELECT * FROM automation_runs WHERE DATE(started_at) = DATE(?) ORDER BY started_at DESC",
            [targetDate]
        );

        const attempts = await db.all(
            "SELECT * FROM application_attempts WHERE DATE(started_at) = DATE(?) ORDER BY started_at DESC",
            [targetDate]
        );

        let discovered = 0;
        let selected = 0;
        let totalAttempts = 0;
        let verifiedApplied = 0;
        let pendingVerification = 0;
        let failed = 0;
        let waitingForInput = 0;

        for (const r of runs) {
            discovered += (r.discovered_count || 0);
            selected += (r.selected_count || 0);
            totalAttempts += (r.attempts_count || 0);
            verifiedApplied += (r.verified_applied_count || 0);
            pendingVerification += (r.pending_verification_count || 0);
            failed += (r.failed_count || 0);
            waitingForInput += (r.waiting_input_count || 0);
        }

        const portalStats = {};
        for (const r of runs) {
            const p = r.portal || "unknown";
            if (!portalStats[p]) {
                portalStats[p] = {
                    runs: 0,
                    discovered: 0,
                    selected: 0,
                    attempts: 0,
                    verified: 0,
                    pending: 0,
                    failed: 0,
                    zeroReasons: []
                };
            }
            portalStats[p].runs++;
            portalStats[p].discovered += (r.discovered_count || 0);
            portalStats[p].selected += (r.selected_count || 0);
            portalStats[p].attempts += (r.attempts_count || 0);
            portalStats[p].verified += (r.verified_applied_count || 0);
            portalStats[p].pending += (r.pending_verification_count || 0);
            portalStats[p].failed += (r.failed_count || 0);
            if (r.zero_reason) portalStats[p].zeroReasons.push(r.zero_reason);
        }

        return {
            date: targetDate,
            totalRuns: runs.length,
            discovered,
            selected,
            attempts: totalAttempts,
            verifiedApplied,
            pendingVerification,
            failed,
            waitingForInput,
            successRate: totalAttempts > 0 ? ((verifiedApplied / totalAttempts) * 100).toFixed(1) : "0.0",
            portalStats,
            runs,
            attemptRecords: attempts
        };
    }

    /**
     * Diagnostic Query: Worker health and latest heartbeats
     * @returns {Promise<Array>}
     */
    async getWorkerHealth() {
        await db.init();
        const workerRegistry = require("../worker/WorkerRegistry");
        const registered = workerRegistry.getAllWorkers();
        
        // Also fetch latest events from worker_events
        const latestEvents = await db.all(`
            SELECT worker_id, event_type, payload, timestamp 
            FROM worker_events 
            WHERE id IN (SELECT MAX(id) FROM worker_events GROUP BY worker_id)
        `);

        return registered.map(w => {
            const ev = latestEvents.find(e => e.worker_id === w.id);
            return {
                id: w.id,
                status: w.status,
                hostname: w.hostname,
                platform: w.platform,
                lastSeen: w.lastSeen,
                isStale: w.isStale,
                currentTaskId: w.currentTaskId,
                capabilities: w.capabilities,
                latestEvent: ev ? ev.event_type : null,
                latestEventTime: ev ? ev.timestamp : null
            };
        });
    }

    /**
     * Diagnostic Query: Success rates breakdown per portal
     * @param {string} [dateStr] 
     * @returns {Promise<Array>}
     */
    async getPortalSuccessRates(dateStr = null) {
        const summary = await this.getDailySummary(dateStr);
        const list = [];
        for (const [portal, stats] of Object.entries(summary.portalStats)) {
            const rate = stats.attempts > 0 ? ((stats.verified / stats.attempts) * 100).toFixed(1) : "0.0";
            list.push({
                portal,
                runs: stats.runs,
                discovered: stats.discovered,
                selected: stats.selected,
                attempts: stats.attempts,
                verified: stats.verified,
                pending: stats.pending,
                failed: stats.failed,
                successRate: `${rate}%`
            });
        }
        return list;
    }

    /**
     * Diagnostic Query: Recent failure reasons and exceptions
     * @param {number} [limit=10] 
     * @returns {Promise<Array>}
     */
    async getRecentErrors(limit = 10) {
        await db.init();
        const runErrors = await db.all(`
            SELECT run_id, portal, worker_id, zero_reason as error, started_at, 'RUN_FAILURE' as type
            FROM automation_runs
            WHERE (status = 'FAILED' OR zero_reason IS NOT NULL)
            ORDER BY started_at DESC LIMIT ?
        `, [limit]);

        const attemptErrors = await db.all(`
            SELECT attempt_id, run_id, portal, job_id, company, title, error_message as error, started_at, 'ATTEMPT_FAILURE' as type
            FROM application_attempts
            WHERE verdict = 'APPLICATION_FAILED' OR error_message IS NOT NULL
            ORDER BY started_at DESC LIMIT ?
        `, [limit]);

        return [...runErrors, ...attemptErrors]
            .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
            .slice(0, limit);
    }
}

module.exports = new ObservabilityStorage();
