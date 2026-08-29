/**
 * Sensitive Data Sanitizer for Network Evidence and Logs
 * Ensures credentials, tokens, cookies, and secrets are NEVER persisted.
 */

class SensitiveDataSanitizer {
    constructor() {
        this.sensitiveHeaderKeys = new Set([
            "authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-csrf-token",
            "x-xsrf-token",
            "x-api-key",
            "api-key",
            "bot-token",
            "token"
        ]);

        this.sensitiveFieldPatterns = [
            /password/i,
            /passcode/i,
            /passwd/i,
            /secret/i,
            /otp/i,
            /token/i,
            /bearer/i,
            /auth/i,
            /api_?key/i,
            /credit_?card/i,
            /cvv/i,
            /ssn/i
        ];
    }

    /**
     * Sanitize HTTP request or response headers
     * @param {Object} headers 
     * @returns {Object}
     */
    sanitizeHeaders(headers) {
        if (!headers || typeof headers !== "object") return {};
        const clean = {};
        for (const [key, value] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey === "authorization") {
                const strVal = String(value);
                if (strVal.toLowerCase().startsWith("bearer")) {
                    clean[key] = "[REDACTED_BEARER_TOKEN]";
                } else if (strVal.toLowerCase().startsWith("basic")) {
                    clean[key] = "[REDACTED_BASIC_AUTH]";
                } else {
                    clean[key] = "[REDACTED_AUTH]";
                }
            } else if (lowerKey === "cookie" || lowerKey === "set-cookie") {
                clean[key] = "[REDACTED_COOKIE]";
            } else if (this.sensitiveHeaderKeys.has(lowerKey) || lowerKey.includes("auth") || lowerKey.includes("token")) {
                clean[key] = "[REDACTED]";
            } else {
                clean[key] = typeof value === "string" ? this.sanitizeString(value) : value;
            }
        }
        return clean;
    }

    /**
     * Sanitize JSON or plain object recursively
     * @param {any} data 
     * @returns {any}
     */
    sanitize(data) {
        if (data === null || data === undefined) return data;
        if (typeof data === "string") return this.sanitizeString(data);
        if (typeof data === "number" || typeof data === "boolean") return data;

        if (Array.isArray(data)) {
            return data.map(item => this.sanitize(item));
        }

        if (typeof data === "object") {
            const sanitized = {};
            for (const [key, value] of Object.entries(data)) {
                if (this.isSensitiveKey(key)) {
                    sanitized[key] = "[REDACTED]";
                } else if (typeof value === "string") {
                    sanitized[key] = this.sanitizeString(value);
                } else if (typeof value === "object") {
                    sanitized[key] = this.sanitize(value);
                } else {
                    sanitized[key] = value;
                }
            }
            return sanitized;
        }

        return data;
    }

    /**
     * Alias for sanitize
     */
    sanitizeData(data) {
        return this.sanitize(data);
    }

    /**
     * Check if key matches known sensitive patterns
     * @param {string} key 
     * @returns {boolean}
     */
    isSensitiveKey(key) {
        if (!key || typeof key !== "string") return false;
        return this.sensitiveFieldPatterns.some(pattern => pattern.test(key));
    }

    /**
     * Redact secrets, bot tokens, bearer tokens from strings
     * @param {string} str 
     * @returns {string}
     */
    sanitizeString(str) {
        if (!str || typeof str !== "string") return "";
        let result = str;

        // Telegram Bot Token pattern: e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ or bot1234...
        result = result.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/g, "[REDACTED_TELEGRAM_TOKEN]");
        result = result.replace(/\/bot\d{8,12}:[A-Za-z0-9_-]{30,40}\//g, "/bot[REDACTED_TELEGRAM_TOKEN]/");
        result = result.replace(/bot\d{8,12}:[A-Za-z0-9_-]{20,}/g, "[REDACTED_SECRET]");
        result = result.replace(/bot[0-9a-zA-Z_-]{20,}/g, "[REDACTED_SECRET]");

        // Bearer token pattern
        result = result.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED_BEARER_TOKEN]");

        // Basic auth headers pattern
        result = result.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED_BASIC_AUTH]");

        // Passwords in query params
        result = result.replace(/([?&](?:password|passwd|pwd|secret|token|otp)=)[^&]+/gi, "$1[REDACTED]");

        return result;
    }
}

const instance = new SensitiveDataSanitizer();
instance.SensitiveDataSanitizer = SensitiveDataSanitizer;
module.exports = instance;
