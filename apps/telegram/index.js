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
     * Centralized External Application Submitted Telegram Alert
     */
    async sendExternalApplicationSubmittedNotification({ portal = "Naukri", ats = "EXTERNAL", company, role, status = "EMPLOYER_PENDING", url, jobId }) {
        const key = `naukri_external_${jobId || 'job'}_APPLICATION_SUBMITTED`;
        if (await this.isNotificationDelivered(key)) {
            localLogger.info(`[Telegram Idempotency] Skipping duplicate alert for key: ${key}`);
            return;
        }

        const safePortal = escapeHTML(portal);
        const safeAts = escapeHTML(ats);
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeStatus = escapeHTML(status);
        const safeUrl = url || "#";

        const text = `<b>✅ External Application Submitted</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal} → ${safeAts}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n` +
            `• <b>Status</b>: <code>${safeStatus}</code>\n` +
            `• <b>Job URL</b>: ${safeUrl}`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, "EXTERNAL_SUBMITTED");
        return res;
    }

    /**
     * Centralized External Action Required Telegram Alert (WAITING_FOR_INPUT, AUTH_REQUIRED, CAPTCHA_REQUIRED, etc.)
     */
    async sendExternalActionRequiredNotification({ portal = "Naukri", ats = "EXTERNAL", company, role, status = "WAITING_FOR_INPUT", reason, url, jobId }) {
        const key = `naukri_external_${jobId || 'job'}_${status}`;
        if (await this.isNotificationDelivered(key)) return;

        const safePortal = escapeHTML(portal);
        const safeAts = escapeHTML(ats);
        const safeCompany = escapeHTML(company || "Company");
        const safeRole = escapeHTML(role || "Target Role");
        const safeStatus = escapeHTML(status);
        const safeReason = escapeHTML(reason || "Action required on external portal");
        const safeUrl = url || "#";

        const text = `<b>⚠️ External Application Action Required</b>\n\n` +
            `• <b>Portal</b>: <code>${safePortal} → ${safeAts}</code>\n` +
            `• <b>Company</b>: <b>${safeCompany}</b>\n` +
            `• <b>Role</b>: <b>${safeRole}</b>\n` +
            `• <b>Status</b>: <code>${safeStatus}</code>\n` +
            `• <b>Details</b>: <i>${safeReason}</i>\n\n` +
            `🔗 <b>External Application Link</b>: ${safeUrl}`;

        const res = await this.sendMessage(text);
        await this.recordNotificationDelivery(key, portal, jobId, status);
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

    /**
     * Central Natural Language & Multi-Mode Command Handler (Phase Y)
     */
    async handleCommand(msg) {
        const text = msg.text || "";
        const commandParser = require("./CommandParser");
        const workerRegistry = require("../../packages/worker/WorkerRegistry");
        const androidWorker = require("../../packages/worker/AndroidWorker");
        const taskQueue = require("../../packages/queue/TaskQueue");
        const candidateKnowledgeService = require("../../packages/knowledge/CandidateKnowledgeService");
        const eventBus = require("../../packages/events/EventBus");
        const db = require("../../packages/database");

        localLogger.info(`Received Telegram Command: "${text}" from User ID: ${msg.from ? msg.from.id : 'unknown'}`);

        // =========================================================================
        // MODE 1 — Automation Mode (Highest Priority)
        // If ANY task or job is in WAITING_FOR_INPUT, all incoming messages belong to that task.
        // =========================================================================
        await db.init();
        const waitingJob = await db.get(
            "SELECT * FROM jobs WHERE status = 'WAITING_FOR_INPUT' ORDER BY updated_at DESC LIMIT 1"
        );
        const waitingTask = await db.get(
            "SELECT * FROM tasks WHERE status = 'WAITING_FOR_INPUT' ORDER BY updated_at DESC LIMIT 1"
        );

        if (waitingJob || waitingTask) {
            const targetItem = waitingJob || waitingTask;
            const questionText = targetItem.pending_question || targetItem.question || "Pending Automation Question";
            const portal = targetItem.portal || "generic";
            const jobId = targetItem.job_id || targetItem.id;

            localLogger.info(`[Automation Mode] Intercepted user answer for waiting question: "${questionText}" -> "${text}"`);

            // 1. Record Answer into Knowledge Bank / Answer Bank
            await candidateKnowledgeService.answerBank.saveAnswer(questionText, text, "TELEGRAM_USER_INPUT", "FACTUAL").catch(() => {});

            // 2. Update DB status to READY_TO_RESUME
            if (waitingJob) {
                await db.run(
                    `UPDATE jobs SET 
                        status = 'READY_TO_RESUME', 
                        pending_suggested_answer = ?, 
                        updated_at = CURRENT_TIMESTAMP 
                     WHERE id = ?`,
                    [text, waitingJob.id]
                );
            }
            if (waitingTask) {
                await db.run(
                    `UPDATE tasks SET 
                        status = 'READY_TO_RESUME', 
                        result = ?, 
                        updated_at = CURRENT_TIMESTAMP 
                     WHERE id = ?`,
                    [JSON.stringify({ answer: text }), waitingTask.id]
                );
            }

            // 3. Emit event to notify waiting worker
            eventBus.publish(eventBus.EVENTS.QUESTION_ANSWERED || "QuestionAnswered", {
                portal,
                jobId,
                question: questionText,
                answer: text,
                source: "TELEGRAM_AUTOMATION_MODE"
            });

            // 4. Respond to Telegram user confirming response forwarded to automation
            const safeQ = escapeHTML(questionText);
            const safeA = escapeHTML(text);
            const safePortal = escapeHTML(portal);
            await this.sendMessage(
                `<b>✅ Answer Forwarded to Automation</b>\n\n` +
                `• <b>Portal</b>: <code>${safePortal}</code>\n` +
                `• <b>Question</b>: <i>"${safeQ}"</i>\n` +
                `• <b>Recorded Answer</b>: <code>${safeA}</code>\n\n` +
                `⚙️ <i>Waiting worker notified. Task resuming...</i>`
            );

            // Automation mode owns the conversation completely until completed/cancelled.
            return;
        }

        // =========================================================================
        // MODE 2 — Command Mode (Second Priority)
        // If no task is waiting, parse deterministic commands locally. Never AI.
        // =========================================================================
        const parsed = commandParser.parse(text);

        switch (parsed.intent) {
            case "START": {
                const targetWorker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
                const taskId = await taskQueue.push(parsed.portal, parsed.action || "apply", { limit: 10 }, targetWorker.id);
                
                await this.sendMessage(
                    `🚀 <b>${escapeHTML(parsed.portal.toUpperCase())} Job Automation</b>\n\n` +
                    `• <b>Portal</b>: <code>${escapeHTML(parsed.portal)}</code>\n` +
                    `• <b>Action</b>: <code>${escapeHTML(parsed.action || 'apply')}</code>\n` +
                    `• <b>Worker</b>:\n<b>${escapeHTML(targetWorker.name || targetWorker.id)}</b>\n` +
                    `• <b>Status</b>:\nQueued\n` +
                    `• <b>Task ID</b>: <code>${taskId.substring(0, 8)}</code>`
                );
                
                await workerRegistry.execute(targetWorker.id, { taskId, portal: parsed.portal, action: parsed.action || "apply", limit: 10 });
                break;
            }

            case "REFRESH_PROFILE": {
                const targetWorker = workerRegistry.getBestWorker(parsed.portal, parsed.targetWorker);
                const taskId = await taskQueue.push(parsed.portal, "updateProfile", {}, targetWorker.id);
                
                await this.sendMessage(
                    `👤 <b>${escapeHTML(parsed.portal.toUpperCase())} Profile Refresh</b>\n\n` +
                    `• <b>Portal</b>: <code>${escapeHTML(parsed.portal)}</code>\n` +
                    `• <b>Worker</b>:\n<b>${escapeHTML(targetWorker.name || targetWorker.id)}</b>\n` +
                    `• <b>Status</b>:\nQueued\n` +
                    `• <b>Task ID</b>: <code>${taskId.substring(0, 8)}</code>`
                );
                
                await workerRegistry.execute(targetWorker.id, { taskId, portal: parsed.portal, action: "updateProfile" });
                break;
            }

            case "HELP": {
                const helpText = `<b>🤖 OpenClaw Telegram Control</b>\n\n` +
                    `<b>Automation Commands</b>\n` +
                    `• <code>start naukri</code>\n` +
                    `• <code>start hirist</code>\n` +
                    `• <code>start cutshort</code>\n` +
                    `• <code>refresh naukri profile</code>\n\n` +
                    `<b>Worker Selection</b>\n` +
                    `• <code>start naukri pc</code>\n` +
                    `• <code>start naukri mobile</code>\n` +
                    `• <code>start naukri oracle</code>\n\n` +
                    `<b>AI Assistant</b>\n` +
                    `• <code>/ai &lt;question&gt;</code>\n\n` +
                    `<b>Examples</b>\n` +
                    `• <code>/ai explain docker</code>\n` +
                    `• <code>start naukri</code>\n` +
                    `• <code>workers</code>\n` +
                    `• <code>status</code>`;
                await this.sendMessage(helpText);
                break;
            }

            case "STOP": {
                await androidWorker.stopJob(parsed.portal);
                await taskQueue.cancelPending(parsed.portal);
                await this.sendMessage(`🛑 <b>Automation Stopped</b>\n\n• Target Portal: <code>${escapeHTML(parsed.portal)}</code>\n• Pending queue cleared and active task terminated.`);
                break;
            }

            case "PAUSE": {
                androidWorker.pause();
                await this.sendMessage(`⏸️ <b>Android Worker Paused</b>\n\nWorker will not process queued tasks until resumed.`);
                break;
            }

            case "RESUME": {
                androidWorker.resume();
                await this.sendMessage(`▶️ <b>Android Worker Resumed</b>\n\nWorker is ready for incoming automation tasks.`);
                break;
            }

            case "WORKERS": {
                const workers = workerRegistry.getAllWorkers();
                let output = `<b>🖥️ OpenClaw Execution Worker Nodes</b>\n\n`;
                for (const w of workers) {
                    const statusEmoji = w.status === "online" ? "🟢" : (w.status === "busy" ? "🟡" : "🔴");
                    const batteryInfo = w.battery ? ` | 🔋 ${w.battery.level}%${w.battery.charging ? '⚡' : ''}` : "";
                    const taskInfo = w.currentTask ? ` | ⚙️ Task: ${w.currentTask}` : "";
                    output += `${statusEmoji} <b>${escapeHTML(w.name)}</b> (<code>${escapeHTML(w.id)}</code>)\n• Status: <code>${w.status.toUpperCase()}</code>${batteryInfo}${taskInfo}\n• Portals: <i>${w.capabilities.slice(0, 4).join(", ")}...</i>\n\n`;
                }
                await this.sendMessage(output);
                break;
            }

            case "HEALTH": {
                const health = await androidWorker.getHealth();
                const text = `<b>🏥 Android Worker Health Status</b>\n\n` +
                    `• <b>Node State</b>: <code>${health.status.toUpperCase()}</code>\n` +
                    `• <b>ADB Device</b>: <code>${health.connection.adbConnected ? 'CONNECTED' : 'EMULATED'}</code>\n` +
                    `• <b>Chrome CDP</b>: <code>${health.connection.cdpConnected ? 'ACTIVE' : 'READY'}</code>\n` +
                    `• <b>Battery Level</b>: <b>${health.battery.level}%</b> (${health.battery.charging ? 'Charging ⚡' : 'Discharging'})\n` +
                    `• <b>Last Heartbeat</b>: <code>${health.lastHeartbeat}</code>`;
                await this.sendMessage(text);
                break;
            }

            case "STATUS": {
                const pendingCount = await taskQueue.getPendingCount();
                const workers = workerRegistry.getAllWorkers();
                const activeCount = workers.filter(w => w.status === "online" || w.status === "busy").length;
                const text = `<b>📊 OpenClaw System Status</b>\n\n` +
                    `• <b>Pending Queue Tasks</b>: <code>${pendingCount}</code>\n` +
                    `• <b>Active Execution Nodes</b>: <code>${activeCount}/${workers.length}</code>\n` +
                    `• <b>System Engine</b>: <code>HEALTHY</code>`;
                await this.sendMessage(text);
                break;
            }

            case "LOGS": {
                const logs = androidWorker.getLogs(8);
                const logBlock = logs.length > 0 ? logs.join("\n") : "No recent log entries.";
                await this.sendMessage(`<b>📜 Android Worker Recent Logs</b>\n\n<pre>${escapeHTML(logBlock)}</pre>`);
                break;
            }

            case "SCREENSHOT": {
                const screenshots = androidWorker.getScreenshots();
                if (screenshots.length > 0) {
                    const latest = screenshots[screenshots.length - 1];
                    await this.sendPhoto(latest, `📸 <b>Latest Android Worker Screenshot</b>`);
                } else {
                    await this.sendMessage(`📸 <b>Screenshot Query</b>: No screenshots captured yet.`);
                }
                break;
            }

            case "HEARTBEAT": {
                await androidWorker.sendHeartbeat();
                await this.sendMessage(`💓 <b>Heartbeat Triggered</b>\n\nHeartbeat ping sent to WorkerRegistry.`);
                break;
            }

            case "RESTART_WORKER": {
                androidWorker.resume();
                await androidWorker.sendHeartbeat();
                await this.sendMessage(`🔄 <b>Android Worker Restarted</b>\n\nWorker process re-initialized successfully.`);
                break;
            }

            // =========================================================================
            // MODE 3 — AI Mode (Explicit ONLY)
            // Triggers ONLY when message starts with /ai (e.g. /ai Explain Docker networking)
            // =========================================================================
            case "AI": {
                const aiService = require("../../packages/ai");
                try {
                    const prompt = parsed.prompt || text;
                    if (!prompt) {
                        await this.sendMessage(`🤖 <b>AI Assistant</b>\n\nPlease provide a question after <code>/ai</code> (e.g. <code>/ai Explain Docker networking</code>).`);
                        break;
                    }
                    const aiReply = await aiService.chatCompletion(prompt);
                    await this.sendMessage(`<b>🤖 OpenClaw AI Assistant</b>\n\n${aiReply}`);
                } catch (aiErr) {
                    localLogger.error(`AI Completion Error: ${aiErr.message}`);
                    await this.sendMessage(`⚠️ <b>AI Service Notice</b>\n\n<i>${escapeHTML(aiErr.message)}</i>\n\nℹ️ <b>System Note</b>: Deterministic automation commands remain 100% operational.`);
                }
                break;
            }

            default: {
                // Non-command text when AI is NOT explicitly requested via /ai
                await this.sendMessage(
                    `❓ <b>Unrecognized Command</b>\n\n` +
                    `AI questions require explicit <code>/ai</code> prefix (e.g. <code>/ai ${escapeHTML(text)}</code>).\n\n` +
                    `Type <code>help</code> to view all available commands.`
                );
                break;
            }
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
                    if (this.chatId && String(fromId) !== String(this.chatId)) {
                        localLogger.warn(`Refused message from unauthorized Chat ID: ${fromId}`);
                        continue;
                    }
                    try {
                        await this.handleCommand(update.message);
                        if (onMessageCallback) await onMessageCallback(update.message);
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
