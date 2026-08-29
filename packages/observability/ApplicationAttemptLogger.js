/**
 * Application Attempt Logger
 * Traces granular step-by-step progress, network/DOM evidence, and final truth verdict for an application.
 */

const crypto = require("crypto");
const path = require("path");
const storage = require("./ObservabilityStorage");
const verdictEvaluator = require("./ApplicationVerdict");
const EvidenceCollector = require("./EvidenceCollector");
const NetworkEvidenceCollector = require("./NetworkEvidenceCollector");
const EVENT_TYPES = require("./EventTypes");
const eventBus = require("../events/EventBus");

class ApplicationAttemptLogger {
    /**
     * @param {Object} params
     * @param {string} params.runId
     * @param {string} [params.taskId]
     * @param {string} params.portal
     * @param {string|number} params.jobId
     * @param {string} params.company
     * @param {string} params.title
     * @param {string} [params.location]
     * @param {string} [params.experience]
     * @param {string} [params.applyType='NATIVE'] NATIVE | EXTERNAL
     * @param {string} [params.workerId='oracle']
     * @param {string} [params.sourceUrl]
     */
    constructor(params = {}) {
        this.attemptId = `app-${crypto.randomBytes(4).toString("hex")}`;
        this.runId = params.runId || `run-${Date.now()}`;
        this.taskId = params.taskId || null;
        this.portal = (params.portal || "generic").toLowerCase();
        this.jobId = String(params.jobId || "0");
        this.company = params.company || "Unknown Company";
        this.title = params.title || "Unknown Role";
        this.location = params.location || "";
        this.experience = params.experience || "";
        this.applyType = params.applyType || "NATIVE";
        this.workerId = params.workerId || "oracle";
        this.sourceUrl = params.sourceUrl || "";
        this.destinationUrl = params.sourceUrl || "";
        this.ats = params.ats || (this.applyType === "EXTERNAL" ? "UNKNOWN_ATS" : "NATIVE");

        this.startedAt = new Date().toISOString();
        this.completedAt = null;
        this.events = [];
        this.errorCode = null;
        this.errorMessage = null;

        // Evidence signals
        this.evidenceSignals = {
            applyClicked: false,
            submitClicked: false,
            networkSuccess: false,
            domConfirmed: false,
            reloadConfirmed: false,
            apiConfirmed: false,
            isWaitingInput: false,
            isExternalOnly: false,
            error: null
        };

        this.jobDir = storage.getJobDir(this.portal, this.runId, this.jobId);
        this.evidenceCollector = new EvidenceCollector({
            runId: this.runId,
            taskId: this.taskId,
            attemptId: this.attemptId,
            portal: this.portal,
            jobId: this.jobId,
            baseDir: this.jobDir
        });

        this.networkCollector = new NetworkEvidenceCollector({
            networkDir: path.join(this.jobDir, "network")
        });

        this.verdict = null;
        this.verificationLevel = "NONE";
    }

    /**
     * Attach Playwright page for evidence tracking
     * @param {import('playwright').Page} page 
     */
    attachPage(page) {
        if (!page) return;
        this.networkCollector.attach(page);
        this.evidenceCollector.recordUrlTransition(page.url(), "initial_attach");
    }

    /**
     * Log a lifecycle event during this attempt
     * @param {string} eventType 
     * @param {Object} [payload] 
     * @param {string} [message] 
     */
    async logStep(eventType, payload = {}, message = "") {
        const timestamp = new Date().toISOString();
        const eventData = {
            timestamp,
            run_id: this.runId,
            task_id: this.taskId,
            application_attempt_id: this.attemptId,
            worker_id: this.workerId,
            portal: this.portal,
            job_id: this.jobId,
            company: this.company,
            title: this.title,
            event_type: eventType,
            status: "IN_PROGRESS",
            message: message || eventType,
            metadata: payload
        };

        this.events.push(eventData);

        // Update signals based on event
        if (eventType === EVENT_TYPES.APPLY_CONTROL_CLICKED) {
            this.evidenceSignals.applyClicked = true;
        } else if (eventType === EVENT_TYPES.SUBMIT_ATTEMPTED || eventType === EVENT_TYPES.ATS_SUBMIT_ATTEMPTED) {
            this.evidenceSignals.submitClicked = true;
        } else if (eventType === EVENT_TYPES.WAITING_FOR_INPUT) {
            this.evidenceSignals.isWaitingInput = true;
        } else if (eventType === EVENT_TYPES.SKIPPED_EXTERNAL_ONLY) {
            this.evidenceSignals.isExternalOnly = true;
        } else if (eventType === EVENT_TYPES.VERIFICATION_PASSED || eventType === EVENT_TYPES.ATS_VERIFIED_APPLIED) {
            this.evidenceSignals.domConfirmed = true;
        }

        // Publish via EventBus and persist
        eventBus.publish(eventType, {
            runId: this.runId,
            taskId: this.taskId,
            applicationAttemptId: this.attemptId,
            workerId: this.workerId,
            portal: this.portal,
            jobId: this.jobId,
            company: this.company,
            title: this.title,
            ...payload
        });

        return eventData;
    }

    /**
     * Capture screenshot at given phase
     * @param {import('playwright').Page} page 
     * @param {string} stage e.g. "before-apply", "form", "before-submit", "after-submit", "after-reload"
     */
    async captureScreenshot(page, stage) {
        const filePath = await this.evidenceCollector.captureScreenshot(page, stage);
        if (filePath) {
            await storage.persistEvidence({
                attemptId: this.attemptId,
                runId: this.runId,
                jobId: this.jobId,
                evidenceType: `SCREENSHOT_${stage.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
                filePath,
                dataJson: { stage, url: page.url() }
            });
        }
        return filePath;
    }

    /**
     * Capture DOM state and confirmation text
     * @param {import('playwright').Page} page 
     */
    async captureDomEvidence(page) {
        const dom = await this.evidenceCollector.extractDomEvidence(page);
        if (dom.hasConfirmText) {
            this.evidenceSignals.domConfirmed = true;
        }
        return dom;
    }

    /**
     * Mark reload verification checked
     * @param {boolean} isConfirmed 
     */
    setReloadConfirmed(isConfirmed) {
        this.evidenceSignals.reloadConfirmed = Boolean(isConfirmed);
    }

    /**
     * Mark authoritative API verification checked
     * @param {boolean} isConfirmed 
     */
    setApiConfirmed(isConfirmed) {
        this.evidenceSignals.apiConfirmed = Boolean(isConfirmed);
    }

    /**
     * Record external redirect / ATS classification
     * @param {Object} redirectInfo
     * @param {string} redirectInfo.destinationUrl
     * @param {string} redirectInfo.ats
     */
    async recordExternalRedirect(redirectInfo = {}) {
        this.destinationUrl = redirectInfo.destinationUrl || this.destinationUrl;
        this.ats = redirectInfo.ats || this.ats;
        this.applyType = "EXTERNAL";

        await this.logStep(EVENT_TYPES.EXTERNAL_REDIRECT_DETECTED, {
            sourceUrl: this.sourceUrl,
            destinationUrl: this.destinationUrl,
            ats: this.ats
        }, `Redirected to external ATS: ${this.ats} (${this.destinationUrl})`);
    }

    /**
     * Conclude application attempt and compute authoritative truth verdict
     * @param {Object} [overrideSignals]
     * @returns {Promise<{ verdict: string, verificationLevel: string, isApplied: boolean, reason: string }>}
     */
    async complete(overrideSignals = {}) {
        this.completedAt = new Date().toISOString();
        this.networkCollector.detach();

        // Check if network collector recorded a positive submission
        if (this.networkCollector.hasSuccessfulSubmissionResponse()) {
            this.evidenceSignals.networkSuccess = true;
        }

        const mergedSignals = {
            ...this.evidenceSignals,
            ...overrideSignals
        };

        const result = verdictEvaluator.evaluate(mergedSignals);
        this.verdict = result.verdict;
        this.verificationLevel = result.verificationLevel;

        if (!result.isApplied && !this.errorMessage) {
            this.errorMessage = result.reason;
        }

        // Persist attempt JSON files
        await storage.saveJobJson(this.jobDir, "application.json", {
            attemptId: this.attemptId,
            runId: this.runId,
            taskId: this.taskId,
            portal: this.portal,
            jobId: this.jobId,
            company: this.company,
            title: this.title,
            location: this.location,
            experience: this.experience,
            applyType: this.applyType,
            ats: this.ats,
            workerId: this.workerId,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            verdict: this.verdict,
            verificationLevel: this.verificationLevel,
            isApplied: result.isApplied,
            reason: result.reason,
            sourceUrl: this.sourceUrl,
            destinationUrl: this.destinationUrl
        });

        await storage.saveJobJson(this.jobDir, "events.json", this.events);

        await storage.saveJobJson(this.jobDir, "verification.json", {
            verdict: this.verdict,
            verificationLevel: this.verificationLevel,
            evidenceSignals: mergedSignals,
            summary: this.evidenceCollector.getSummary()
        });

        // Persist to SQLite
        await storage.persistApplicationAttempt({
            attemptId: this.attemptId,
            runId: this.runId,
            taskId: this.taskId,
            portal: this.portal,
            jobId: this.jobId,
            company: this.company,
            title: this.title,
            location: this.location,
            experience: this.experience,
            applyType: this.applyType,
            workerId: this.workerId,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            verdict: this.verdict,
            verificationLevel: this.verificationLevel,
            applicationId: this.evidenceCollector.applicationId,
            sourceUrl: this.sourceUrl,
            destinationUrl: this.destinationUrl,
            ats: this.ats,
            errorCode: this.errorCode,
            errorMessage: this.errorMessage
        });

        return result;
    }
}

module.exports = ApplicationAttemptLogger;
