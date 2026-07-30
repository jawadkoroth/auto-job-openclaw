const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../../packages/config");
const logger = require("../../packages/logger");
const db = require("../../packages/database");

function redactSecrets(text) {
    if (!text) return "";
    let result = String(text);
    if (config.telegram.botToken) {
        const tokenPattern = config.telegram.botToken.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        result = result.replace(new RegExp(tokenPattern, 'g'), "[REDACTED_BOT_TOKEN]");
    }
    if (config.telegram.chatId) {
        result = result.replace(new RegExp(config.telegram.chatId, 'g'), "[REDACTED_CHAT_ID]");
    }
    result = result.replace(/bot[0-9a-zA-Z_-]+/g, "bot[REDACTED_BOT_TOKEN]");
    return result;
}

const localLogger = {
    info: (msg, meta) => logger.telegram.info(redactSecrets(msg), meta),
    warn: (msg, meta) => logger.telegram.warn(redactSecrets(msg), meta),
    error: (msg, meta) => logger.telegram.error(redactSecrets(msg), meta),
    debug: (msg, meta) => logger.telegram.debug(redactSecrets(msg), meta)
};

function escapeHTML(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function markdownToHTML(text) {
    if (!text) return "";
    
    // 1. Preserve existing valid Telegram HTML tags by replacing them with non-underscore placeholders
    const placeholders = [];
    const htmlTagRegex = /<\/?(b|i|code|pre|a|u|s|tg-spoiler)(\s+[^>]*>|>)/gi;
    let textWithPlaceholders = text.replace(htmlTagRegex, (tag) => {
        placeholders.push(tag);
        return `:::HTMLTAG${placeholders.length - 1}:::`;
    });
        
    // 2. Escape HTML special chars in remaining text (avoiding double-escaping existing entities)
    let escaped = textWithPlaceholders
        .replace(/&(?!amp;|lt;|gt;|quot;|#39;)/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // 3. Restore valid HTML tags
    escaped = escaped.replace(/:::HTMLTAG(\d+):::/g, (match, index) => {
        return placeholders[parseInt(index, 10)];
    });
        
    // 4. Convert Markdown tokens to HTML tags
    // Triple backticks code blocks: ```code``` -> <pre>code</pre>
    escaped = escaped.replace(/```([\s\S]*?)```/g, (match, p1) => {
        return `<pre>${p1}</pre>`;
    });
    
    // Single backtick inline code: `code` -> <code>code</code>
    escaped = escaped.replace(/`([^`]+)`/g, (match, p1) => {
        return `<code>${p1}</code>`;
    });
    
    // Protect <code>...</code> and <pre>...</pre> content using non-underscore placeholders
    const codeBlocks = [];
    escaped = escaped.replace(/<(code|pre)[\s\S]*?<\/\1>/gi, (match) => {
        codeBlocks.push(match);
        return `:::CODEBLOCKTAG${codeBlocks.length - 1}:::`;
    });

    // Bold: **text** or *text* -> <b>text</b>
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<b>$1</b>');
    
    // Italic: _text_ -> <i>text</i>
    escaped = escaped.replace(/_([^_]+)_/g, '<i>$1</i>');

    // Restore protected code blocks
    escaped = escaped.replace(/:::CODEBLOCKTAG(\d+):::/g, (match, index) => {
        return codeBlocks[parseInt(index, 10)];
    });
    
    return escaped;
}

class TelegramService {
    constructor() {
        this.token = config.telegram.botToken;
        this.chatId = config.telegram.chatId;
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;
        this.isPolling = false;
        this.lastUpdateId = 0;
        this.localDeliveriesPath = path.join(process.cwd(), "sessions", "naukri", "telegram_deliveries.json");
        try { fs.mkdirpSync(path.dirname(this.localDeliveriesPath)); } catch (e) {}
    }

    _readLocalDeliveries() {
        if (fs.existsSync(this.localDeliveriesPath)) {
            try {
                return fs.readJsonSync(this.localDeliveriesPath) || [];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    _writeLocalDeliveries(list) {
        try {
            fs.writeJsonSync(this.localDeliveriesPath, list, { spaces: 2 });
        } catch (e) {}
    }

    async isNotificationDelivered(key) {
        if (!key) return false;

        // 1. Check local persistent JSON store
        const localList = this._readLocalDeliveries();
        if (localList.includes(key)) return true;

        // 2. Check SQLite database table
        try {
            await db.init();
            const row = await db.get("SELECT id FROM notification_deliveries WHERE notification_key = ?", [key]);
            if (row) {
                // Sync back to local store
                localList.push(key);
                this._writeLocalDeliveries(localList);
                return true;
            }
        } catch (e) {}

        return false;
    }

    async recordNotificationDelivery(key, portal = "", jobId = "", type = "") {
        if (!key) return;

        // 1. Save to local persistent JSON store
        const localList = this._readLocalDeliveries();
        if (!localList.includes(key)) {
            localList.push(key);
            this._writeLocalDeliveries(localList);
        }

        // 2. Save to SQLite database table
        try {
            await db.init();
            await db.run(
                "INSERT OR IGNORE INTO notification_deliveries (notification_key, portal, job_id, notification_type) VALUES (?, ?, ?, ?)",
                [key, portal, jobId, type]
            );
        } catch (e) {}
    }

    /**
     * Centralized Application Submitted Telegram Alert
     */
    async sendApplicationSubmittedNotification({ portal, company, role, status, url, jobId }) {
        const key = `${(portal || 'generic').toLowerCase()}_${jobId || 'job'}_APPLICATION_SUBMITTED`;
        if (await this.isNotificationDelivered(key)) {
            localLogger.info(`[Telegram Idempotency] Skipping duplicate alert for key: ${key}`);
            return;
        }

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeStatus = escapeHTML(status || "EMPLOYER_PENDING");
        const safeUrl = url || "#";

        const text = `<b>✅ Application Submitted</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n` +
            `• <b>Status</b>: <code>${safeStatus}</code>\n` +
            `• <b>Job URL</b>: ${safeUrl}`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "SUBMITTED");
        return res;
    }

    /**
     * Centralized Question Needs Input Telegram Alert
     */
    async sendQuestionInputNotification({ portal, company, role, question, suggestedAnswer, url, jobId }) {
        const key = `${portal || 'generic'}_${jobId || 'job'}_QUESTION_INPUT`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeQuestion = escapeHTML(question || "No details provided");
        const safeAnswer = escapeHTML(suggestedAnswer || "Yes");
        const safeUrl = url || "#";

        const text = `<b>❓ Application Needs Input</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n\n` +
            `❓ <b>Question</b>:\n<i>"${safeQuestion}"</i>\n\n` +
            `💡 <b>Suggested Answer</b>:\n<i>"${safeAnswer}"</i>\n\n` +
            `🔗 <b>Job URL</b>: ${safeUrl}`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "QUESTION_INPUT");
        return res;
    }

    /**
     * Centralized Application Failure Telegram Alert
     */
    async sendApplicationFailedNotification({ portal, company, role, reason, url, jobId }) {
        const key = `${portal || 'generic'}_${jobId || 'job'}_FAILED`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeReason = escapeHTML(reason || "Application execution error");
        const safeUrl = url || "#";

        const text = `<b>⚠️ Application Failed</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n` +
            `• <b>Reason</b>: <code>${safeReason}</code>\n` +
            `• <b>Job URL</b>: ${safeUrl}`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "FAILED");
        return res;
    }

    /**
     * Centralized Run Summary Completion Alert
     */
    async sendRunSummaryNotification({ portal, discovered, eligible, attempted, applied, waitingForInput, failed, skippedDuplicates }) {
        const safePortal = escapeHTML(portal || "Portal");
        const text = `<b>📊 ${safePortal.toUpperCase()} RUN COMPLETE</b>\n\n` +
            `• <b>Discovered</b>: ${discovered || 0}\n` +
            `• <b>Eligible</b>: ${eligible || 0}\n` +
            `• <b>Attempted</b>: ${attempted || 0}\n` +
            `• <b>Applied</b>: ${applied || 0}\n` +
            `• <b>Waiting For Input</b>: ${waitingForInput || 0}\n` +
            `• <b>Failed</b>: ${failed || 0}\n` +
            `• <b>Skipped/Duplicates</b>: ${skippedDuplicates || 0}`;

        return await this.sendMessage(text);
    }

    async sendInterviewNotification({ portal, company, role, details, url, jobId }) {
        const key = `${portal || 'generic'}_${jobId || 'job'}_INTERVIEW`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeDetails = escapeHTML(details || "Interview request received.");

        const text = `<b>🎯 Interview Request</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n\n` +
            `<i>${safeDetails}</i>`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "INTERVIEW");
        return res;
    }

    async sendCodingTestNotification({ portal, company, role, details, url, jobId }) {
        const key = `${portal || 'generic'}_${jobId || 'job'}_CODING_TEST`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeDetails = escapeHTML(details || "Coding test challenge received.");

        const text = `<b>🧪 Coding Test Received</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n\n` +
            `<i>${safeDetails}</i>`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "CODING_TEST");
        return res;
    }

    async sendOfferNotification({ portal, company, role, details, url, jobId }) {
        const key = `${portal || 'generic'}_${jobId || 'job'}_OFFER`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");

        const text = `<b>🎉 Offer Received</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n\n` +
            `Congratulations!`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "OFFER");
        return res;
    }

    /**
     * Send structured notification object via Telegram
     */
    async sendNotification({ title, message }) {
        const text = `<b>${title || "OpenClaw Notification"}</b>\n${message || ""}`;
        return await this.sendMessage(text);
    }

    /**
     * Send question prompt requiring user approval/answer
     */
    async sendQuestionPrompt({ jobId, company, title, question, portal, approvalId }) {
        const safePortal = escapeHTML(portal || "Job Portal");
        const safeCompany = escapeHTML(company || "N/A");
        const safeTitle = escapeHTML(title || "Question Required");
        const safeJobId = escapeHTML(jobId || "N/A");
        const safeQuestion = escapeHTML(question || "");
        const safeApprovalId = escapeHTML(approvalId || "N/A");

        const text = `<b>❓ ${safeTitle}</b>\n` +
            `Company: <b>${safeCompany}</b> (${safePortal})\n` +
            `Job ID: <code>${safeJobId}</code>\n\n` +
            `Question:\n<i>"${safeQuestion}"</i>\n\n` +
            `To answer, reply to this message or update the Candidate Dashboard. (Approval ID: <code>${safeApprovalId}</code>)`;
        return await this.sendMessage(text);
    }

    /**
     * Send HTML message to target Telegram Chat
     */
    async sendMessage(text) {
        if (!this.token || !this.chatId) {
            localLogger.warn("Telegram credentials not configured. Skipping sendMessage.");
            return;
        }
        const endpoint = `${this.baseUrl}/sendMessage`;
        const htmlText = markdownToHTML(text);
        const payload = {
            chat_id: this.chatId,
            text: htmlText,
            parse_mode: "HTML"
        };
        localLogger.info(`Telegram send payload: ${JSON.stringify(payload)}`);
        try {
            await axios.post(endpoint, payload);
            localLogger.info("Telegram text alert sent.", { action: "telegram_send" });
        } catch (error) {
            if (error.response && error.response.status === 400) {
                localLogger.error(`Telegram 400 Bad Request: Endpoint=${endpoint}, Payload=${JSON.stringify(payload)}, Response=${JSON.stringify(error.response.data)}`);
            } else {
                localLogger.error(`Telegram send message failed: ${error.message}`, { action: "telegram_send", success: false });
            }
        }
    }

    /**
     * Send a local image/screenshot to target Telegram Chat
     */
    async sendPhoto(photoPath, caption) {
        if (!this.token || !this.chatId) {
            localLogger.warn("Telegram credentials not configured. Skipping sendPhoto.");
            return;
        }
        if (!fs.existsSync(photoPath)) {
            localLogger.warn(`Photo file not found: ${photoPath}`);
            return;
        }
        const endpoint = `${this.baseUrl}/sendPhoto`;
        const htmlCaption = markdownToHTML(caption);
        try {
            const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
            const fileBuffer = fs.readFileSync(photoPath);
            const filename = path.basename(photoPath);

            const parts = [
                `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${htmlCaption}\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
            ];

            const body = Buffer.concat([
                Buffer.from(parts.join("")),
                fileBuffer,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            await axios.post(endpoint, body, {
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`
                }
            });
            localLogger.info(`Telegram photo alert sent: ${filename}`, { action: "telegram_send_photo" });
        } catch (error) {
            if (error.response && error.response.status === 400) {
                localLogger.error(`Telegram 400 Bad Request (Photo): Endpoint=${endpoint}, Response=${JSON.stringify(error.response.data)}`);
            } else {
                localLogger.error(`Telegram send photo failed: ${error.message}`, { action: "telegram_send_photo", success: false });
            }
        }
    }

    async getUpdates() {
        try {
            const response = await axios.get(`${this.baseUrl}/getUpdates`, {
                params: {
                    offset: this.lastUpdateId + 1,
                    timeout: 5
                },
                timeout: 10000
            });
            return response.data.result || [];
        } catch (error) {
            localLogger.debug(`Telegram poll update failed: ${error.message}`);
            return [];
        }
    }

    startPolling(onMessageCallback) {
        if (!this.token) {
            localLogger.warn("Telegram Bot token missing. Interactive commands listener is disabled.");
            return;
        }
        if (this.isPolling) return;
        this.isPolling = true;
        localLogger.info("Telegram Bot updates listener thread launched.");
        
        const poll = async () => {
            if (!this.isPolling) return;
            const updates = await this.getUpdates();
            for (const update of updates) {
                this.lastUpdateId = update.update_id;
                if (update.message && update.message.text) {
                    const fromId = update.message.chat.id;
                    if (String(fromId) !== String(this.chatId)) {
                        localLogger.warn(`Refused message from unauthorized Chat ID: ${fromId}`);
                        continue;
                    }
                    try {
                        await onMessageCallback(update.message);
                    } catch (err) {
                        localLogger.error(`Failed handling telegram command: ${err.stack}`);
                    }
                }
            }
            setTimeout(poll, 1500);
        };
        poll();
    }

    stopPolling() {
        this.isPolling = false;
        localLogger.info("Telegram Bot listener stopped.");
    }

    escapeHTML(str) {
        return escapeHTML(str);
    }

    markdownToHTML(str) {
        return markdownToHTML(str);
    }
}

const telegramService = new TelegramService();
telegramService.escapeHTML = escapeHTML;
telegramService.markdownToHTML = markdownToHTML;

module.exports = telegramService;
