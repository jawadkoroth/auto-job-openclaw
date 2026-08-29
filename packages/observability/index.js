/**
 * OpenClaw Observability & Application Truth Layer
 * Central exports
 */

const EVENT_TYPES = require("./EventTypes");
const sanitizer = require("./SensitiveDataSanitizer");
const ApplicationVerdict = require("./ApplicationVerdict");
const EvidenceCollector = require("./EvidenceCollector");
const NetworkEvidenceCollector = require("./NetworkEvidenceCollector");
const ObservabilityStorage = require("./ObservabilityStorage");
const AutomationRunLogger = require("./AutomationRunLogger");
const ApplicationAttemptLogger = require("./ApplicationAttemptLogger");
const workerEventLogger = require("./WorkerEventLogger");

module.exports = {
    EVENT_TYPES,
    sanitizer,
    SensitiveDataSanitizer: sanitizer,
    ApplicationVerdict,
    VERDICTS: ApplicationVerdict.VERDICTS,
    VERIFICATION_LEVELS: ApplicationVerdict.VERIFICATION_LEVELS,
    EvidenceCollector,
    NetworkEvidenceCollector,
    storage: ObservabilityStorage,
    AutomationRunLogger,
    ApplicationAttemptLogger,
    workerEventLogger,

    /**
     * Helper to instantiate a new run logger
     * @param {Object} params 
     */
    createRunLogger(params) {
        return new AutomationRunLogger(params);
    },

    /**
     * Helper to instantiate a new application attempt logger
     * @param {Object} params 
     */
    createAttemptLogger(params) {
        return new ApplicationAttemptLogger(params);
    }
};
