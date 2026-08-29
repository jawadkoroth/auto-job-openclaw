/**
 * Application Truth Model & Verdict Resolver
 * 
 * Strict Invariants:
 * - Apply button clicked != Applied
 * - Form completed != Applied
 * - Submit clicked != Applied
 * - Only VERIFIED_APPLIED yields applied = 1 in the database.
 */

const VERDICTS = {
    DISCOVERED: "DISCOVERED",
    ELIGIBILITY_REJECTED: "ELIGIBILITY_REJECTED",
    SELECTED: "SELECTED",
    APPLICATION_STARTED: "APPLICATION_STARTED",
    FORM_COMPLETED: "FORM_COMPLETED",
    SUBMIT_CLICKED: "SUBMIT_CLICKED",
    SUBMISSION_PENDING_VERIFICATION: "SUBMISSION_PENDING_VERIFICATION",
    VERIFIED_APPLIED: "VERIFIED_APPLIED",
    APPLICATION_FAILED: "APPLICATION_FAILED",
    UNKNOWN: "UNKNOWN",

    // Aliases & legacy compatible states
    CLICKED_UNVERIFIED: "CLICKED_UNVERIFIED",
    SKIPPED_EXTERNAL_ONLY: "SKIPPED_EXTERNAL_ONLY",
    WAITING_FOR_INPUT: "WAITING_FOR_INPUT"
};

const VERIFICATION_LEVELS = {
    NONE: "NONE",
    DOM_TOAST: "DOM_TOAST",
    NETWORK_200: "NETWORK_200",
    PAGE_RELOAD_CONFIRMED: "PAGE_RELOAD_CONFIRMED",
    AUTHORITATIVE_API_CONFIRMED: "AUTHORITATIVE_API_CONFIRMED",
    EXTERNAL_CONFIRMATION_PAGE: "EXTERNAL_CONFIRMATION_PAGE"
};

class ApplicationVerdict {
    get VERDICTS() {
        return VERDICTS;
    }

    get VERIFICATION_LEVELS() {
        return VERIFICATION_LEVELS;
    }

    /**
     * Compute authoritative verdict from evidence signals
     * @param {Object} evidence
     * @param {boolean} evidence.applyClicked
     * @param {boolean} evidence.submitClicked
     * @param {boolean} evidence.networkSuccess (e.g. HTTP 200/201 on apply endpoint)
     * @param {boolean} evidence.domConfirmed (e.g. "Application Submitted" text visible)
     * @param {boolean} evidence.reloadConfirmed (e.g. reload shows "Applied" state)
     * @param {boolean} evidence.apiConfirmed (e.g. portal API returns application record)
     * @param {boolean} evidence.formCompleted
     * @param {boolean} evidence.isWaitingInput
     * @param {boolean} evidence.isExternalOnly
     * @param {string} [evidence.error]
     * @returns {{ verdict: string, verificationLevel: string, isApplied: boolean, reason: string }}
     */
    evaluate(evidence = {}) {
        const {
            applyClicked = false,
            submitClicked = false,
            networkSuccess = false,
            domConfirmed = false,
            reloadConfirmed = false,
            apiConfirmed = false,
            formCompleted = false,
            isWaitingInput = false,
            isExternalOnly = false,
            error = null
        } = evidence;

        let result = null;
        if (error) {
            result = {
                verdict: VERDICTS.APPLICATION_FAILED,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: error
            };
        } else if (isWaitingInput) {
            result = {
                verdict: VERDICTS.WAITING_FOR_INPUT,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: "Application requires candidate question answering or approval"
            };
        } else if (isExternalOnly) {
            result = {
                verdict: VERDICTS.SKIPPED_EXTERNAL_ONLY,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: "Skipped submission on external portal in current execution mode"
            };
        } else if (apiConfirmed) {
            result = {
                verdict: VERDICTS.VERIFIED_APPLIED,
                verificationLevel: VERIFICATION_LEVELS.AUTHORITATIVE_API_CONFIRMED,
                isApplied: true,
                reason: "Confirmed applied via authoritative portal application API"
            };
        } else if (reloadConfirmed) {
            result = {
                verdict: VERDICTS.VERIFIED_APPLIED,
                verificationLevel: VERIFICATION_LEVELS.PAGE_RELOAD_CONFIRMED,
                isApplied: true,
                reason: "Confirmed applied via post-submission page reload state"
            };
        } else if (domConfirmed && networkSuccess) {
            result = {
                verdict: VERDICTS.VERIFIED_APPLIED,
                verificationLevel: VERIFICATION_LEVELS.DOM_TOAST,
                isApplied: true,
                reason: "Confirmed applied via DOM confirmation text and successful network submission"
            };
        } else if (submitClicked && networkSuccess) {
            result = {
                verdict: VERDICTS.SUBMISSION_PENDING_VERIFICATION,
                verificationLevel: VERIFICATION_LEVELS.NETWORK_200,
                isApplied: false,
                reason: "Submit succeeded over network but final portal reload verification is unconfirmed"
            };
        } else if (submitClicked) {
            result = {
                verdict: VERDICTS.SUBMISSION_PENDING_VERIFICATION,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: "Submit button clicked without authoritative confirmation"
            };
        } else if (applyClicked) {
            result = {
                verdict: VERDICTS.CLICKED_UNVERIFIED,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: "Apply control clicked without verifiable submission confirmation"
            };
        } else if (formCompleted) {
            result = {
                verdict: VERDICTS.FORM_COMPLETED,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: "Application form filled but submit not completed"
            };
        } else {
            result = {
                verdict: VERDICTS.APPLICATION_FAILED,
                verificationLevel: VERIFICATION_LEVELS.NONE,
                isApplied: false,
                reason: error || "Application flow did not complete"
            };
        }

        result.applied = result.isApplied ? 1 : 0;
        result.level = result.verificationLevel;
        return result;
    }

    resolve(evidence = {}) {
        return this.evaluate(evidence);
    }
}

const verdictInstance = new ApplicationVerdict();
verdictInstance.ApplicationVerdict = ApplicationVerdict;
verdictInstance.VERDICTS = VERDICTS;
verdictInstance.VERIFICATION_LEVELS = VERIFICATION_LEVELS;
module.exports = verdictInstance;
