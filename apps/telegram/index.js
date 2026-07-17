const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../../packages/config");
const logger = require("../../packages/logger");

function redactSecrets(text) {
    if (!text) return "";
    let result = String(text);
    if (config.telegram.botToken) {
        // Escape regex special chars in token
        const tokenPattern = config.telegram.botToken.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        result = result.replace(new RegExp(tokenPattern, 'g'), "[REDACTED_BOT_TOKEN]");
    }
    if (config.telegram.chatId) {
        result = result.replace(new RegExp(config.telegram.chatId, 'g'), "[REDACTED_CHAT_ID]");
    }
    // Match potential raw Telegram bot tokens in URLs (e.g., bot123456:ABC-DEF...)
    result = result.replace(/bot[0-9a-zA-Z_-]+/g, "bot[REDACTED_BOT_TOKEN]");
    return result;
}

const localLogger = {
    info: (msg, meta) => logger.telegram.info(redactSecrets(msg), meta),
    warn: (msg, meta) => logger.telegram.warn(redactSecrets(msg), meta),
    error: (msg, meta) => logger.telegram.error(redactSecrets(msg), meta),
    debug: (msg, meta) => logger.telegram.debug(redactSecrets(msg), meta)
};

function markdownToHTML(text) {
    if (!text) return "";
    
    // First, escape HTML special chars
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // Now convert Markdown tokens to HTML tags
    // 1. Triple backticks code blocks: ```code``` -> <pre>code</pre>
    escaped = escaped.replace(/```([\s\S]*?)```/g, (match, p1) => {
        return `<pre>${p1}</pre>`;
    });
    
    // 2. Single backtick inline code: `code` -> <code>code</code>
    escaped = escaped.replace(/`([^`]+)`/g, (match, p1) => {
        return `<code>${p1}</code>`;
    });
    
    // 3. Bold: *text* or **text** -> <b>text</b>
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<b>$1</b>');
    
    // 4. Italic: _text_ -> <i>text</i>
    escaped = escaped.replace(/_([^_]+)_/g, '<i>$1</i>');
    
    return escaped;
}

class TelegramService {
    constructor() {
        this.token = config.telegram.botToken;
        this.chatId = config.telegram.chatId;
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;
        this.isPolling = false;
        this.lastUpdateId = 0;
    }

    /**
     * Send HTML message to target Telegram Chat
     * @param {string} text 
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
     * @param {string} photoPath 
     * @param {string} caption 
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
        const payload = {
            chat_id: this.chatId,
            caption: htmlCaption,
            photoPath: photoPath
        };
        localLogger.info(`Telegram send photo payload: ${JSON.stringify(payload)}`);
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

    /**
     * Poll update logs from Telegram servers
     * @returns {Promise<any[]>}
     */
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

    /**
     * Launch polling thread for interactive operations
     * @param {Function} onMessageCallback 
     */
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
                    
                    // Strict chat validation for server security
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

    /**
     * Stop active polling session
     */
    stopPolling() {
        this.isPolling = false;
        localLogger.info("Telegram Bot listener stopped.");
    }
}

module.exports = new TelegramService();
