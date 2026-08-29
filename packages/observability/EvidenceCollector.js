/**
 * Evidence Collector for Application Attempts
 * Captures screenshots, DOM signals, URL transitions, and page state.
 */

const path = require("path");
const fs = require("fs-extra");

class EvidenceCollector {
    /**
     * @param {Object} options
     * @param {string} options.runId
     * @param {string} options.taskId
     * @param {string} options.attemptId
     * @param {string} options.portal
     * @param {string} options.jobId
     * @param {string} options.baseDir Directory path for storing artifacts
     */
    constructor(options = {}) {
        this.runId = options.runId || `run-${Date.now()}`;
        this.taskId = options.taskId || `task-${Date.now()}`;
        this.attemptId = options.attemptId || `att-${Date.now()}`;
        this.portal = options.portal || "generic";
        this.jobId = String(options.jobId || "unknown");
        this.baseDir = options.baseDir || path.join(process.cwd(), "sessions", "observability", "temp");
        
        this.screenshotsDir = path.join(this.baseDir, "screenshots");
        this.urlTransitions = [];
        this.domSignals = {};
        this.confirmationText = null;
        this.applicationId = null;

        try {
            fs.ensureDirSync(this.screenshotsDir);
        } catch (e) {}
    }

    /**
     * Capture screenshot stage
     * @param {import('playwright').Page} page 
     * @param {string} stage e.g. "before-apply", "form", "before-submit", "after-submit", "after-reload"
     * @returns {Promise<string|null>} Saved file path
     */
    async captureScreenshot(page, stage) {
        if (!page || typeof page.screenshot !== "function") return null;

        try {
            const fileName = `${stage}.png`;
            const filePath = path.join(this.screenshotsDir, fileName);
            await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 }).catch(() => {});
            return filePath;
        } catch (err) {
            return null;
        }
    }

    /**
     * Track navigation / URL transition
     * @param {string} url 
     * @param {string} [stage] 
     */
    recordUrlTransition(url, stage = "navigation") {
        if (!url) return;
        this.urlTransitions.push({
            timestamp: new Date().toISOString(),
            stage,
            url
        });
    }

    /**
     * Extract key DOM evidence from active page
     * @param {import('playwright').Page} page 
     * @returns {Promise<Object>}
     */
    async extractDomEvidence(page) {
        if (!page || typeof page.evaluate !== "function") return {};

        try {
            const domData = await page.evaluate(() => {
                const title = document.title || "";
                const url = window.location.href || "";
                const bodyText = document.body ? document.body.innerText.substring(0, 3000) : "";

                // Look for common confirmation phrases
                const confirmMatches = [
                    "applied", "application submitted", "successfully applied",
                    "application received", "thank you for applying", "already applied"
                ].filter(phrase => bodyText.toLowerCase().includes(phrase));

                // Look for application reference ID patterns (e.g. App #12345, Reference: ABC-123)
                let refId = null;
                const idMatch = bodyText.match(/(?:application|reference|confirmation|req)\s*(?:id|#|number)?[:\s]+([A-Za-z0-9\-_]{4,20})/i);
                if (idMatch) refId = idMatch[1];

                return {
                    title,
                    url,
                    confirmMatches,
                    applicationId: refId,
                    hasConfirmText: confirmMatches.length > 0
                };
            }).catch(() => ({}));

            if (domData.hasConfirmText) {
                this.confirmationText = (domData.confirmMatches || []).join(", ");
            }
            if (domData.applicationId) {
                this.applicationId = domData.applicationId;
            }
            this.domSignals = domData;
            return domData;
        } catch (err) {
            return {};
        }
    }

    /**
     * Get collected summary of evidence
     */
    getSummary() {
        return {
            attemptId: this.attemptId,
            jobId: this.jobId,
            portal: this.portal,
            urlTransitions: this.urlTransitions,
            domSignals: this.domSignals,
            confirmationText: this.confirmationText,
            applicationId: this.applicationId,
            screenshotsDir: this.screenshotsDir
        };
    }
}

module.exports = EvidenceCollector;
