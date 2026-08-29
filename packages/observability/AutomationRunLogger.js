/**
 * Automation Run Logger
 * Traces end-to-end automation run lifecycle, discovery metrics, selection, and outcomes.
 */

const crypto = require("crypto");
const storage = require("./ObservabilityStorage");
const EVENT_TYPES = require("./EventTypes");
const eventBus = require("../events/EventBus");
const logger = require("../logger");

class AutomationRunLogger {
    /**
     * @param {Object} params
     * @param {string} params.portal
     * @param {string} [params.action='apply']
     * @param {string} [params.workerId='oracle']
     * @param {string} [params.taskId]
     * @param {string} [params.runId]
     * @param {string} [params.triggerType='SCHEDULED']
     */
    constructor(params = {}) {
        this.portal = (params.portal || "generic").toLowerCase();
        this.action = params.action || "apply";
        this.workerId = params.workerId || "oracle";
        this.taskId = params.taskId || null;
        this.triggerType = params.triggerType || "SCHEDULED";

        this.runId = params.runId || this.generateRunId(this.portal);
        this.startedAt = new Date().toISOString();
        this.finishedAt = null;
        this.status = "RUNNING";
        this.runDir = storage.getRunDir(this.portal, this.runId);

        this.metrics = {
            discovered: 0,
            roleEligible: 0,
            experienceEligible: 0,
            locationEligible: 0,
            sreRejected: 0,
            roleRejected: 0,
            experienceRejected: 0,
            locationRejected: 0,
            duplicates: 0,
            selected: 0,
            attempts: 0,
            verifiedApplied: 0,
            pendingVerification: 0,
            clickedUnverified: 0,
            waitingForInput: 0,
            failed: 0,
            externalAtsAttempts: 0,
            zeroReason: null,
            rejectionBreakdown: {},
            mainFailureReasons: []
        };
    }

    /**
     * Generate unique standard run_id
     * Format: <portal>-YYYYMMDD-HHMMSS-<random6>
     * @param {string} portal 
     */
    generateRunId(portal) {
        const p = (portal || "run").toLowerCase().replace(/[^a-z0-9]/g, "");
        const d = new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        const rand = crypto.randomBytes(3).toString("hex");
        return `${p}-${yyyy}${mm}${dd}-${hh}${min}${ss}-${rand}`;
    }

    /**
     * Emit and persist structured lifecycle event
     * @param {string} eventType 
     * @param {Object} payload 
     * @param {string} [message] 
     */
    async logEvent(eventType, payload = {}, message = "") {
        const timestamp = new Date().toISOString();
        const eventRecord = {
            timestamp,
            run_id: this.runId,
            task_id: this.taskId,
            worker_id: this.workerId,
            portal: this.portal,
            event_type: eventType,
            status: this.status,
            message: message || eventType,
            metadata: payload
        };

        await storage.appendRunLog(this.runDir, `[${eventType}] ${message} | metadata=${JSON.stringify(payload)}`);

        // Emit through central EventBus
        eventBus.publish(eventType, {
            runId: this.runId,
            taskId: this.taskId,
            workerId: this.workerId,
            portal: this.portal,
            ...payload
        });

        return eventRecord;
    }

    /**
     * Start automation run
     */
    async start() {
        this.status = "RUNNING";
        await this.logEvent(EVENT_TYPES.RUN_STARTED, {
            triggerType: this.triggerType,
            portal: this.portal,
            action: this.action,
            workerId: this.workerId
        }, `Run started for portal ${this.portal} (${this.triggerType})`);

        await this.syncToDb();
    }

    /**
     * Record discovered job
     * @param {Object} job 
     */
    async recordDiscovered(job) {
        this.metrics.discovered++;
        await this.logEvent(EVENT_TYPES.JOB_DISCOVERED, {
            jobId: job.id || job.job_id,
            title: job.title,
            company: job.company,
            location: job.location,
            experience: job.experience
        }, `Discovered job: ${job.title} at ${job.company}`);
    }

    /**
     * Record rejected job
     * @param {Object} job 
     * @param {string} reasonType ROLE | EXPERIENCE | LOCATION | SRE | DUPLICATE | OTHER
     * @param {string} reasonDetails 
     */
    async recordRejection(job, reasonType, reasonDetails) {
        const type = (reasonType || "OTHER").toUpperCase();
        let eventType = EVENT_TYPES.JOB_REJECTED_OTHER;

        if (type === "ROLE") {
            this.metrics.roleRejected++;
            eventType = EVENT_TYPES.JOB_REJECTED_ROLE;
        } else if (type === "EXPERIENCE") {
            this.metrics.experienceRejected++;
            eventType = EVENT_TYPES.JOB_REJECTED_EXPERIENCE;
        } else if (type === "LOCATION") {
            this.metrics.locationRejected++;
            eventType = EVENT_TYPES.JOB_REJECTED_LOCATION;
        } else if (type === "SRE") {
            this.metrics.sreRejected++;
            eventType = EVENT_TYPES.JOB_REJECTED_SRE;
        } else if (type === "DUPLICATE") {
            this.metrics.duplicates++;
            eventType = EVENT_TYPES.JOB_DUPLICATE;
        }

        const reasonKey = `${type}: ${reasonDetails || 'Criteria not met'}`;
        this.metrics.rejectionBreakdown[reasonKey] = (this.metrics.rejectionBreakdown[reasonKey] || 0) + 1;

        await this.logEvent(eventType, {
            jobId: job.id || job.job_id,
            title: job.title,
            company: job.company,
            reason: reasonDetails
        }, `Rejected job (${type}): ${reasonDetails}`);
    }

    /**
     * Record candidate job selected for application
     * @param {Object} job 
     * @param {number} rankScore 
     */
    async recordSelected(job, rankScore = 0) {
        this.metrics.selected++;
        await this.logEvent(EVENT_TYPES.JOB_SELECTED, {
            jobId: job.id || job.job_id,
            title: job.title,
            company: job.company,
            rankScore
        }, `Selected candidate job #${this.metrics.selected}: ${job.title} (Score: ${rankScore})`);
    }

    /**
     * Record outcome of an application attempt
     * @param {Object} result
     * @param {string} result.verdict
     * @param {boolean} [result.isExternal]
     * @param {string} [result.reason]
     */
    recordAttemptOutcome(result = {}) {
        this.metrics.attempts++;
        const verdict = result.verdict || "APPLICATION_FAILED";

        if (result.isExternal) {
            this.metrics.externalAtsAttempts++;
        }

        switch (verdict) {
            case "VERIFIED_APPLIED":
                this.metrics.verifiedApplied++;
                break;
            case "SUBMISSION_PENDING_VERIFICATION":
                this.metrics.pendingVerification++;
                break;
            case "CLICKED_UNVERIFIED":
                this.metrics.clickedUnverified++;
                break;
            case "WAITING_FOR_INPUT":
                this.metrics.waitingForInput++;
                break;
            case "APPLICATION_FAILED":
            default:
                this.metrics.failed++;
                if (result.reason) {
                    this.metrics.mainFailureReasons.push(result.reason);
                }
                break;
        }
    }

    get discoveredCount() { return this.metrics.discovered; }
    get selectedCount() { return this.metrics.selected; }
    get appliedCount() { return this.metrics.verifiedApplied; }
    get zeroReason() { return this.metrics.zeroReason; }
    get rejections() { 
        return { 
            sre: this.metrics.sreRejected, 
            experience: this.metrics.experienceRejected,
            location: this.metrics.locationRejected,
            role: this.metrics.roleRejected,
            duplicate: this.metrics.duplicates
        }; 
    }

    /**
     * Complete and finalize run, calculate statistics and sync to DB
     * @returns {Promise<string>} Summary markdown text
     */
    async finish() {
        this.finishedAt = new Date().toISOString();
        this.status = "COMPLETED";
        const durationMs = new Date(this.finishedAt) - new Date(this.startedAt);

        // Determine zero-application reason if zero verified applications
        if (this.metrics.verifiedApplied === 0) {
            if (this.metrics.discovered === 0) {
                this.metrics.zeroReason = "ZERO_JOBS_DISCOVERED";
            } else if (this.metrics.selected === 0) {
                if (this.metrics.experienceRejected > 0 && this.metrics.experienceRejected === this.metrics.discovered) {
                    this.metrics.zeroReason = "ALL_CANDIDATES_REJECTED_EXPERIENCE";
                } else if (this.metrics.sreRejected > 0 && this.metrics.sreRejected === this.metrics.discovered) {
                    this.metrics.zeroReason = "ALL_CANDIDATES_REJECTED_SRE";
                } else if (this.metrics.locationRejected > 0 && this.metrics.locationRejected === this.metrics.discovered) {
                    this.metrics.zeroReason = "ALL_CANDIDATES_REJECTED_LOCATION";
                } else {
                    this.metrics.zeroReason = "ALL_DISCOVERED_JOBS_REJECTED";
                }
            } else if (this.metrics.attempts === 0) {
                this.metrics.zeroReason = "NO_APPLICATION_ATTEMPTS_LAUNCHED";
            } else if (this.metrics.waitingForInput > 0 && this.metrics.failed === 0) {
                this.metrics.zeroReason = "WAITING_FOR_USER_QUESTIONNAIRE_INPUT";
            } else {
                this.metrics.zeroReason = "APPLICATIONS_UNVERIFIED_OR_FAILED";
            }
        }

        const summary = this.generateSummaryText();
        await this.logEvent(EVENT_TYPES.RUN_FINISHED, {
            metrics: this.metrics,
            durationMs,
            zeroReason: this.metrics.zeroReason
        }, `Run completed in ${(durationMs / 1000).toFixed(1)}s`);

        await storage.saveRunJson(this.runDir, {
            runId: this.runId,
            taskId: this.taskId,
            portal: this.portal,
            action: this.action,
            workerId: this.workerId,
            status: this.status,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            durationMs,
            metrics: this.metrics,
            summary
        });

        await this.syncToDb();
        return summary;
    }

    /**
     * Mark run as failed
     * @param {string|Error} err 
     */
    async fail(err) {
        this.finishedAt = new Date().toISOString();
        this.status = "FAILED";
        const errMsg = err && err.message ? err.message : String(err);
        const stack = err && err.stack ? err.stack : null;
        const durationMs = new Date(this.finishedAt) - new Date(this.startedAt);

        this.metrics.zeroReason = `RUNNER_EXCEPTION: ${errMsg}`;

        await this.logEvent(EVENT_TYPES.RUN_FAILED, {
            error: errMsg,
            stack,
            durationMs
        }, `Run failed: ${errMsg}`);

        await storage.saveRunJson(this.runDir, {
            runId: this.runId,
            taskId: this.taskId,
            portal: this.portal,
            status: this.status,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            durationMs,
            error: errMsg,
            stack,
            metrics: this.metrics
        });

        await this.syncToDb();
    }

    /**
     * Format standard human-readable Daily / Run Summary
     * @returns {string}
     */
    generateSummaryText() {
        const m = this.metrics;
        const durationSec = ((new Date(this.finishedAt || new Date()) - new Date(this.startedAt)) / 1000).toFixed(1);
        const rate = m.attempts > 0 ? ((m.verifiedApplied / m.attempts) * 100).toFixed(1) : "0.0";

        let text = `<b>${this.portal.toUpperCase()} RUN SUMMARY</b>\n`;
        text += `--------------------------------------------------\n`;
        text += `• <b>Run ID</b>: <code>${this.runId}</code>\n`;
        text += `• <b>Worker Node</b>: <code>${this.workerId}</code>\n`;
        text += `• <b>Duration</b>: <code>${durationSec}s</code>\n\n`;

        text += `<b>Discovery & Selection:</b>\n`;
        text += `• Discovered:              <b>${m.discovered}</b>\n`;
        text += `• Role Eligible:           <b>${m.roleEligible || (m.discovered - m.roleRejected)}</b>\n`;
        text += `• Experience Eligible:     <b>${m.experienceEligible || (m.discovered - m.experienceRejected)}</b>\n`;
        text += `• Location Eligible:       <b>${m.locationEligible || (m.discovered - m.locationRejected)}</b>\n`;
        text += `• SRE Rejected:            <b>${m.sreRejected}</b>\n`;
        text += `• Duplicates Removed:      <b>${m.duplicates}</b>\n`;
        text += `• Final Candidates:        <b>${m.selected}</b>\n\n`;

        text += `<b>Application Execution:</b>\n`;
        text += `• Application Attempts:    <b>${m.attempts}</b>\n`;
        text += `• Verified Applied:        <b>${m.verifiedApplied}</b>\n`;
        text += `• Pending Verification:    <b>${m.pendingVerification}</b>\n`;
        text += `• Clicked Unverified:      <b>${m.clickedUnverified}</b>\n`;
        text += `• Waiting For Input:       <b>${m.waitingForInput}</b>\n`;
        text += `• Failed:                  <b>${m.failed}</b>\n`;
        text += `• External ATS Attempts:   <b>${m.externalAtsAttempts}</b>\n\n`;

        text += `• <b>REAL APPLICATION RATE</b>: <b>${rate}%</b>\n`;

        if (m.verifiedApplied === 0 && m.zeroReason) {
            text += `\n⚠️ <b>Zero Verified Applications Reason</b>: <code>${m.zeroReason}</code>\n`;
        }

        return text;
    }

    async syncToDb() {
        const durationMs = this.finishedAt ? (new Date(this.finishedAt) - new Date(this.startedAt)) : 0;
        await storage.persistRun({
            runId: this.runId,
            portal: this.portal,
            action: this.action,
            workerId: this.workerId,
            taskId: this.taskId,
            status: this.status,
            triggerType: this.triggerType,
            discoveredCount: this.metrics.discovered,
            eligibleCount: this.metrics.selected,
            selectedCount: this.metrics.selected,
            attemptsCount: this.metrics.attempts,
            verifiedAppliedCount: this.metrics.verifiedApplied,
            pendingVerificationCount: this.metrics.pendingVerification,
            clickedUnverifiedCount: this.metrics.clickedUnverified,
            waitingInputCount: this.metrics.waitingForInput,
            failedCount: this.metrics.failed,
            zeroReason: this.metrics.zeroReason,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            durationMs,
            summaryJson: this.metrics
        });
    }
}

module.exports = AutomationRunLogger;
