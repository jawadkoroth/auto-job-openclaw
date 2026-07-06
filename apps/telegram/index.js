const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../../packages/config");
const logger = require("../../packages/logger");

class TelegramService {
    constructor() {
        this.token = config.telegram.botToken;
        this.chatId = config.telegram.chatId;
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;
        this.isPolling = false;
        this.lastUpdateId = 0;
    }

    /**
     * Send Markdown message to target Telegram Chat
     * @param {string} text 
     */
    async sendMessage(text) {
        if (!this.token || !this.chatId) {
            logger.telegram.warn("Telegram credentials not configured. Skipping sendMessage.");
            return;
        }
        try {
            await axios.post(`${this.baseUrl}/sendMessage`, {
                chat_id: this.chatId,
                text: text,
                parse_mode: "Markdown"
            });
            logger.telegram.info("Telegram text alert sent.", { action: "telegram_send" });
        } catch (error) {
            logger.telegram.error(`Telegram send message failed: ${error.message}`, { action: "telegram_send", success: false });
        }
    }

    /**
     * Send a local image/screenshot to target Telegram Chat
     * @param {string} photoPath 
     * @param {string} caption 
     */
    async sendPhoto(photoPath, caption) {
        if (!this.token || !this.chatId) {
            logger.telegram.warn("Telegram credentials not configured. Skipping sendPhoto.");
            return;
        }
        if (!fs.existsSync(photoPath)) {
            logger.telegram.warn(`Photo file not found: ${photoPath}`);
            return;
        }
        try {
            const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
            const fileBuffer = fs.readFileSync(photoPath);
            const filename = path.basename(photoPath);

            const parts = [
                `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption || ""}\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
            ];

            const body = Buffer.concat([
                Buffer.from(parts.join("")),
                fileBuffer,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            await axios.post(`${this.baseUrl}/sendPhoto`, body, {
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`
                }
            });
            logger.telegram.info(`Telegram photo alert sent: ${filename}`, { action: "telegram_send_photo" });
        } catch (error) {
            logger.telegram.error(`Telegram send photo failed: ${error.message}`, { action: "telegram_send_photo", success: false });
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
            logger.telegram.debug(`Telegram poll update failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Launch polling thread for interactive operations
     * @param {Function} onMessageCallback 
     */
    startPolling(onMessageCallback) {
        if (!this.token) {
            logger.telegram.warn("Telegram Bot token missing. Interactive commands listener is disabled.");
            return;
        }
        if (this.isPolling) return;
        this.isPolling = true;
        logger.telegram.info("Telegram Bot updates listener thread launched.");
        
        const poll = async () => {
            if (!this.isPolling) return;
            const updates = await this.getUpdates();
            for (const update of updates) {
                this.lastUpdateId = update.update_id;
                if (update.message && update.message.text) {
                    const fromId = update.message.chat.id;
                    
                    // Strict chat validation for server security
                    if (String(fromId) !== String(this.chatId)) {
                        logger.telegram.warn(`Refused message from unauthorized Chat ID: ${fromId}`);
                        continue;
                    }
                    try {
                        await onMessageCallback(update.message);
                    } catch (err) {
                        logger.telegram.error(`Failed handling telegram command: ${err.stack}`);
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
        logger.telegram.info("Telegram Bot listener stopped.");
    }
}

module.exports = new TelegramService();
