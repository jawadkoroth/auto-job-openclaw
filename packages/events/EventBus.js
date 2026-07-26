const EventEmitter = require("events");
const crypto = require("crypto");
const db = require("../database");
const logger = require("../logger").automation;

const EVENTS = {
    JOB_DISCOVERED: "JOB_DISCOVERED",
    APPLICATION_STARTED: "APPLICATION_STARTED",
    APPLICATION_SUBMITTED: "APPLICATION_SUBMITTED",
    CONVERSATION_CREATED: "CONVERSATION_CREATED",
    QUESTIONNAIRE_FOUND: "QUESTIONNAIRE_FOUND",
    QUESTION_ANSWERED: "QUESTION_ANSWERED",
    WAITING_FOR_INPUT: "WAITING_FOR_INPUT",
    QUESTIONNAIRE_SUBMITTED: "QUESTIONNAIRE_SUBMITTED",
    INTERVIEW_REQUESTED: "INTERVIEW_REQUESTED",
    CODING_TEST_RECEIVED: "CODING_TEST_RECEIVED",
    OFFER_RECEIVED: "OFFER_RECEIVED",
    APPLICATION_REJECTED: "APPLICATION_REJECTED",
    APPLICATION_CLOSED: "APPLICATION_CLOSED"
};

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.EVENTS = EVENTS;
        this.emittedEvents = new Set();
        this.registerDefaultListeners();
    }

    /**
     * Publish a structured lifecycle event to all subscribers and persist to database
     * @param {string} eventType Name of lifecycle event
     * @param {Object} payload Metadata payload (jobId, conversationId, portal, etc.)
     */
    publish(eventType, payload = {}) {
        const portalKey = payload.portal ? payload.portal.toLowerCase() : "generic";
        const jobIdKey = payload.jobId ? String(payload.jobId) : "N/A";
        const dedupeKey = `${portalKey}_${jobIdKey}_${eventType}`;

        if (this.emittedEvents.has(dedupeKey)) {
            logger.warn(`[EventBus] Skipping duplicate lifecycle event ${eventType} for job ${jobIdKey} (${portalKey})`);
            return null;
        }

        this.emittedEvents.add(dedupeKey);
        const timestamp = new Date().toISOString();
        const eventId = `evt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const eventData = { eventId, eventType, timestamp, ...payload };

        logger.info(`[EventBus] Emitting event ${eventType} for job ${payload.jobId || 'N/A'} (Portal: ${payload.portal || 'N/A'})`);

        // Emit synchronously to in-memory listeners
        this.emit(eventType, eventData);
        this.emit("*", eventData);

        // Async persistence to application_events table
        this.persistEvent(eventData).catch(err => {
            logger.error(`[EventBus] Persistence error for event ${eventType}: ${err.message}`);
        });

        return eventData;
    }

    /**
     * Persist event to Oracle SQLite application_events table
     * @param {Object} eventData 
     */
    async persistEvent(eventData) {
        await db.init();
        const { eventId, eventType, jobId, conversationId, portal, ...rest } = eventData;
        
        const portalStr = String(portal || "generic").toLowerCase();
        const jobIdStr = String(jobId || "N/A");

        if (["APPLICATION_STARTED", "APPLICATION_SUBMITTED", "QUESTIONNAIRE_FOUND", "QUESTIONNAIRE_SUBMITTED"].includes(eventType)) {
            const existing = await db.get(
                `SELECT id FROM application_events WHERE LOWER(portal) = ? AND job_id = ? AND event_type = ?`,
                [portalStr, jobIdStr, eventType]
            );
            if (existing) {
                return;
            }
        }

        await db.run(
            `INSERT INTO application_events (
                event_id, job_id, conversation_id, portal, event_type, payload
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                eventId,
                jobIdStr,
                conversationId ? String(conversationId) : null,
                portalStr,
                eventType,
                JSON.stringify(rest)
            ]
        );
    }

    /**
     * Register core system listeners for decoupled event processing
     */
    registerDefaultListeners() {
        // Subscriber: Employer Knowledge Learning
        this.on(EVENTS.QUESTION_ANSWERED, async (data) => {
            if (data.portal && data.company && data.question && data.answer) {
                const employerKnowledgeService = require("../knowledge/EmployerKnowledgeService");
                await employerKnowledgeService.updateEmployerKnowledge({
                    portal: data.portal,
                    companyName: data.company,
                    questionnaireItem: { question: data.question, answer: data.answer }
                }).catch(() => {});
            }
        });

        // Subscriber: Telegram High-Priority Notifications (Isolated from application state)
        this.on(EVENTS.APPLICATION_SUBMITTED, async (data) => {
            try {
                const telegramService = require("../../apps/telegram");
                await telegramService.sendApplicationSubmittedNotification({
                    portal: data.portal,
                    company: data.company,
                    role: data.title || data.role,
                    status: data.status || "EMPLOYER_PENDING",
                    url: data.url,
                    jobId: data.jobId
                });
            } catch (err) {
                logger.error(`[EventBus] TELEGRAM_DELIVERY_FAILED for APPLICATION_SUBMITTED: ${err.message}`);
            }
        });

        this.on(EVENTS.WAITING_FOR_INPUT, async (data) => {
            try {
                const telegramService = require("../../apps/telegram");
                await telegramService.sendQuestionInputNotification({
                    portal: data.portal,
                    company: data.company,
                    role: data.title || data.role,
                    question: data.question,
                    suggestedAnswer: data.suggestedAnswer,
                    url: data.url,
                    jobId: data.jobId
                });
            } catch (err) {
                logger.error(`[EventBus] TELEGRAM_DELIVERY_FAILED for WAITING_FOR_INPUT: ${err.message}`);
            }
        });

        this.on(EVENTS.INTERVIEW_REQUESTED, async (data) => {
            try {
                const telegramService = require("../../apps/telegram");
                await telegramService.sendInterviewNotification({
                    portal: data.portal,
                    company: data.company,
                    role: data.title || data.role,
                    details: data.message || "Interview request received.",
                    url: data.url,
                    jobId: data.jobId
                });
            } catch (err) {
                logger.error(`[EventBus] TELEGRAM_DELIVERY_FAILED for INTERVIEW_REQUESTED: ${err.message}`);
            }
        });

        this.on(EVENTS.CODING_TEST_RECEIVED, async (data) => {
            try {
                const telegramService = require("../../apps/telegram");
                await telegramService.sendCodingTestNotification({
                    portal: data.portal,
                    company: data.company,
                    role: data.title || data.role,
                    details: data.message || "Coding test challenge received.",
                    url: data.url,
                    jobId: data.jobId
                });
            } catch (err) {
                logger.error(`[EventBus] TELEGRAM_DELIVERY_FAILED for CODING_TEST_RECEIVED: ${err.message}`);
            }
        });

        this.on(EVENTS.OFFER_RECEIVED, async (data) => {
            try {
                const telegramService = require("../../apps/telegram");
                await telegramService.sendOfferNotification({
                    portal: data.portal,
                    company: data.company,
                    role: data.title || data.role,
                    details: data.message || "Job offer received.",
                    url: data.url,
                    jobId: data.jobId
                });
            } catch (err) {
                logger.error(`[EventBus] TELEGRAM_DELIVERY_FAILED for OFFER_RECEIVED: ${err.message}`);
            }
        });
    }
}

const eventBusInstance = new EventBus();
module.exports = eventBusInstance;
