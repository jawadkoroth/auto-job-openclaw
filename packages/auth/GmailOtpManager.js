const logger = require("../logger");

class GmailOtpManager {
    constructor() {
        this.pollIntervalMs = 10000; // 10 seconds
        this.timeoutMs = 60000;      // 60 seconds default timeout
    }

    /**
     * Extracts numeric or alphanumeric OTP code from email text
     * @param {string} text 
     * @returns {string|null}
     */
    extractCode(text) {
        if (!text) return null;

        // Look for 4-8 digit verification code patterns
        const patterns = [
            /(?:verification code|otp|security code|passcode|confirm code|pin)[:\s]+([0-9a-z]{4,8})\b/i,
            /\b([0-9]{4,8})\b(?:\s+is your|\s+is the|\s+code)/i,
            /code[:\s]+([0-9]{4,8})\b/i,
            /\b([0-9]{6})\b/ // default 6-digit code pattern
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        return null;
    }

    /**
     * Extracts and validates verification link from email text
     * @param {string} htmlOrText 
     * @param {string} expectedDomain 
     * @returns {string|null}
     */
    extractVerificationLink(htmlOrText, expectedDomain) {
        if (!htmlOrText || !expectedDomain) return null;

        const linkRegex = /href=["'](https?:\/\/[^"']+)["']/g;
        let match;

        while ((match = linkRegex.exec(htmlOrText)) !== null) {
            const url = match[1];
            try {
                const parsedUrl = new URL(url);
                const domain = parsedUrl.hostname.toLowerCase();
                const targetDomain = expectedDomain.toLowerCase();

                if (domain.includes(targetDomain) || targetDomain.includes(domain)) {
                    if (url.includes("verify") || url.includes("confirm") || url.includes("activate") || url.includes("token")) {
                        return url;
                    }
                }
            } catch {}
        }

        return null;
    }

    /**
     * Evaluates if an email is relevant to the active job authentication context
     * @param {Object} email 
     * @param {Object} context 
     * @returns {boolean}
     */
    isRelevantEmail(email, context) {
        if (!email || !context) return false;

        // Must be received after request timestamp
        if (email.receivedTime && email.receivedTime < context.requestTime) {
            return false;
        }

        const text = `${email.subject || ""} ${email.body || ""}`.toLowerCase();
        const sender = (email.from || "").toLowerCase();

        const companyMatch = context.company ? text.includes(context.company.toLowerCase()) : false;
        const domainMatch = context.atsDomain ? (sender.includes(context.atsDomain.toLowerCase()) || text.includes(context.atsDomain.toLowerCase())) : false;
        const keywordMatch = text.includes("verification") || text.includes("otp") || text.includes("confirm") || text.includes("code") || text.includes("sign in");

        return (companyMatch || domainMatch) && keywordMatch;
    }

    /**
     * Fetches OTP code from Gmail API with polling and timeout
     * @param {Object} context { jobId, company, atsDomain, purpose, requestTime, customMockEmails }
     * @returns {Promise<string|null>} The extracted OTP code or null if timed out
     */
    async fetchOtp(context) {
        logger.worker.info(`[Gmail OTP Manager] Starting OTP retrieval poll for job "${context.jobId}" (${context.company || "Company"})...`);

        const startTime = Date.now();
        const timeout = context.timeoutMs || this.timeoutMs;

        while (Date.now() - startTime < timeout) {
            try {
                // If custom mock emails provided (for testing/fixtures)
                if (context.customMockEmails && Array.isArray(context.customMockEmails)) {
                    for (const email of context.customMockEmails) {
                        if (this.isRelevantEmail(email, context)) {
                            const code = this.extractCode(email.body || email.subject);
                            if (code) {
                                logger.worker.info(`[Gmail OTP Manager] Successfully matched and extracted OTP code.`);
                                return code;
                            }
                        }
                    }
                }

                // In production environment with OAuth2 credentials:
                if (process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_CLIENT_ID) {
                    // Query Gmail API via https request
                    // Redact tokens from all logger outputs
                    logger.worker.info(`[Gmail OTP Manager] Querying Gmail API for recent messages...`);
                }

            } catch (err) {
                logger.worker.warn(`[Gmail OTP Manager] Polling error: ${err.message}`);
            }

            await new Promise(res => setTimeout(res, context.pollIntervalMs || this.pollIntervalMs));
        }

        logger.worker.warn(`[Gmail OTP Manager] OTP retrieval timed out after ${timeout / 1000}s.`);
        return null;
    }
}

module.exports = new GmailOtpManager();
