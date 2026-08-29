/**
 * Network Evidence Collector
 * Captures and sanitizes application-related HTTP requests and responses.
 * Never persists raw cookies, auth headers, or secrets.
 */

const path = require("path");
const fs = require("fs-extra");
const sanitizer = require("./SensitiveDataSanitizer");

class NetworkEvidenceCollector {
    /**
     * @param {Object} options
     * @param {string} options.networkDir
     */
    constructor(options = {}) {
        this.networkDir = options.networkDir || path.join(process.cwd(), "sessions", "observability", "temp", "network");
        this.capturedRequests = [];
        this.page = null;
        this._requestHandler = null;
        this._responseHandler = null;

        try {
            fs.ensureDirSync(this.networkDir);
        } catch (e) {}
    }

    /**
     * Start capturing network traffic on a Playwright page
     * @param {import('playwright').Page} page 
     */
    attach(page) {
        if (!page || typeof page.on !== "function") return;
        this.page = page;

        this._responseHandler = async (response) => {
            try {
                const request = response.request();
                const method = request.method();
                const url = request.url();

                // Target relevant application submissions, API updates, or POST/PUT calls
                const isRelevant = 
                    method === "POST" || 
                    method === "PUT" || 
                    url.includes("apply") || 
                    url.includes("submit") || 
                    url.includes("application") ||
                    url.includes("job") ||
                    url.includes("candidate") ||
                    url.includes("graphql");

                if (!isRelevant) return;

                const status = response.status();
                const headers = sanitizer.sanitizeHeaders(response.headers());
                const requestHeaders = sanitizer.sanitizeHeaders(request.headers());
                
                let postData = null;
                try {
                    postData = sanitizer.sanitizeData(request.postDataJSON() || request.postData());
                } catch (e) {
                    postData = sanitizer.sanitizeString(request.postData() || "");
                }

                let responseBody = null;
                try {
                    const text = await response.text().catch(() => null);
                    if (text && text.length < 50000) {
                        try {
                            responseBody = sanitizer.sanitizeData(JSON.parse(text));
                        } catch (e) {
                            responseBody = sanitizer.sanitizeString(text.substring(0, 2000));
                        }
                    }
                } catch (e) {}

                const entry = {
                    timestamp: new Date().toISOString(),
                    method,
                    url: sanitizer.sanitizeString(url),
                    status,
                    ok: response.ok(),
                    requestHeaders,
                    postData,
                    responseHeaders: headers,
                    responseBody
                };

                this.capturedRequests.push(entry);

                // Persist to network directory
                const fileName = `req_${this.capturedRequests.length}_${method}_${status}.json`;
                fs.writeJson(path.join(this.networkDir, fileName), entry, { spaces: 2 }).catch(() => {});
            } catch (err) {}
        };

        page.on("response", this._responseHandler);
    }

    /**
     * Detach network listeners safely
     */
    detach() {
        if (this.page && this._responseHandler) {
            try {
                this.page.off("response", this._responseHandler);
            } catch (e) {}
            this._responseHandler = null;
            this.page = null;
        }
    }

    /**
     * Check if any successful submission network call occurred (HTTP 200/201/204 on apply endpoint)
     * @returns {boolean}
     */
    hasSuccessfulSubmissionResponse() {
        return this.capturedRequests.some(r => {
            const isSubmit = r.method === "POST" || r.method === "PUT" || r.url.includes("apply") || r.url.includes("submit");
            return isSubmit && r.status >= 200 && r.status < 300;
        });
    }

    /**
     * Retrieve all captured sanitized records
     */
    getEntries() {
        return this.capturedRequests;
    }
}

module.exports = NetworkEvidenceCollector;
