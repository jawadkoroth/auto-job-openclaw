/**
 * Worker Event Logger
 * Records worker heartbeats, lifecycle events, task receipt, ACK, execution, and outcomes.
 */

const storage = require("./ObservabilityStorage");
const EVENT_TYPES = require("./EventTypes");
const eventBus = require("../events/EventBus");

class WorkerEventLogger {
    /**
     * Log worker heartbeat
     * @param {string} workerId 
     * @param {Object} metrics 
     */
    async logHeartbeat(workerId, metrics = {}) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: EVENT_TYPES.WORKER_HEARTBEAT,
            runId: metrics.runId || null,
            taskId: metrics.currentTask || null,
            payload: metrics
        });
    }

    /**
     * Log worker status transition (online/offline)
     * @param {string} workerId 
     * @param {string} status 
     * @param {Object} [details] 
     */
    async logStatus(workerId, status, details = {}) {
        const eventType = status === "online" ? EVENT_TYPES.WORKER_ONLINE : EVENT_TYPES.WORKER_OFFLINE;
        await storage.persistWorkerEvent({
            workerId,
            eventType,
            payload: { status, ...details }
        });
    }

    /**
     * Log task receipt / poll
     * @param {string} workerId 
     * @param {string} taskId 
     * @param {string} portal 
     * @param {string} action 
     * @param {string} [runId] 
     */
    async logTaskReceived(workerId, taskId, portal, action, runId = null) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: EVENT_TYPES.TASK_RECEIVED,
            runId,
            taskId,
            payload: { portal, action }
        });
    }

    /**
     * Log task acknowledgment
     * @param {string} workerId 
     * @param {string} taskId 
     * @param {string} [runId] 
     */
    async logTaskAcknowledged(workerId, taskId, runId = null) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: EVENT_TYPES.TASK_ACKNOWLEDGED,
            runId,
            taskId,
            payload: { acknowledgedAt: new Date().toISOString() }
        });
    }

    /**
     * Log task start on worker
     * @param {string} workerId 
     * @param {string} taskId 
     * @param {string} runId 
     * @param {Object} [details] 
     */
    async logTaskStarted(workerId, taskId, runId = null, details = {}) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: EVENT_TYPES.TASK_STARTED,
            runId,
            taskId,
            payload: { startedAt: new Date().toISOString(), ...details }
        });
    }

    /**
     * Log launcher process startup
     * @param {string} workerId 
     * @param {string} taskId 
     * @param {string} runId 
     * @param {string} launcherScript 
     */
    async logLauncherStarted(workerId, taskId, runId, launcherScript) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: "LAUNCHER_STARTED",
            runId,
            taskId,
            payload: { launcherScript, startedAt: new Date().toISOString() }
        });
    }

    /**
     * Log browser instance launched
     * @param {string} workerId 
     * @param {string} runId 
     * @param {string} [portal] 
     */
    async logBrowserStarted(workerId, runId, portal = "generic") {
        await storage.persistWorkerEvent({
            workerId,
            eventType: EVENT_TYPES.BROWSER_STARTED,
            runId,
            payload: { portal, startedAt: new Date().toISOString() }
        });
    }

    /**
     * Log job processing step on worker
     * @param {string} workerId 
     * @param {string} runId 
     * @param {string} jobId 
     * @param {string} title 
     * @param {string} company 
     */
    async logJobProcessing(workerId, runId, jobId, title, company) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: "JOB_PROCESSING",
            runId,
            payload: { jobId, title, company, startedAt: new Date().toISOString() }
        });
    }

    /**
     * Log application result from worker
     * @param {string} workerId 
     * @param {string} runId 
     * @param {string} jobId 
     * @param {string} verdict 
     */
    async logApplicationResult(workerId, runId, jobId, verdict) {
        await storage.persistWorkerEvent({
            workerId,
            eventType: "APPLICATION_RESULT",
            runId,
            payload: { jobId, verdict, completedAt: new Date().toISOString() }
        });
    }

    /**
     * Log launcher execution outcome
     * @param {Object} params
     * @param {string} params.workerId
     * @param {string} params.taskId
     * @param {string} [params.runId]
     * @param {number} params.exitCode
     * @param {number} params.durationMs
     * @param {string} [params.error]
     */
    async logLauncherOutcome(params = {}) {
        const { workerId, taskId, runId, exitCode, durationMs, error } = params;
        const isSuccess = exitCode === 0;
        const eventType = isSuccess ? EVENT_TYPES.TASK_COMPLETED : EVENT_TYPES.TASK_FAILED;

        await storage.persistWorkerEvent({
            workerId,
            eventType,
            runId,
            taskId,
            payload: { exitCode, durationMs, error }
        });
    }
}

module.exports = new WorkerEventLogger();
