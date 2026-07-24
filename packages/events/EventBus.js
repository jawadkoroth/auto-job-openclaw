const EventEmitter = require("events");
const crypto = require("crypto");
const db = require("../database");
const logger = require("../logger").automation;

const EVENTS = {
    JOB_DISCOVERED: "JOB_DISCOVERED",
    APPLICATION_STARTED: "APPLICATION_STARTED",
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
        this.registerDefaultListeners();
    }

    /**
     * Publish a structured lifecycle event to all subscribers and persist to database
     * @param {string} eventType Name of lifecycle event
     * @param {Object} payload Metadata payload (jobId, conversationId, portal, etc.)
     */
    publish(eventType, payload = {}) {
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
        
        await db.run(
            `INSERT INTO application_events (
                event_id, job_id, conversation_id, portal, event_type, payload
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                eventId,
                String(jobId || "N/A"),
                conversationId ? String(conversationId) : null,
                String(portal || "generic"),
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

        // Subscriber: Telegram High-Priority Notifications
        this.on(EVENTS.INTERVIEW_REQUESTED, async (data) => {
            const telegramService = require("../../apps/telegram");
            await telegramService.sendNotification({
                title: `🎯 Interview Request Received (${data.portal})`,
                message: `Company: ${data.company || 'Employer'}\nMessage: "${String(data.message || '').slice(0, 300)}"`
            }).catch(() => {});
        });

        this.on(EVENTS.OFFER_RECEIVED, async (data) => {
            const telegramService = require("../../apps/telegram");
            await telegramService.sendNotification({
                title: `🎉 Job Offer Received (${data.portal})`,
                message: `Company: ${data.company || 'Employer'}\nCongratulations!`
            }).catch(() => {});
        });
    }
}

const eventBusInstance = new EventBus();
module.exports = eventBusInstance;
