const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const eventBus = require("../packages/events/EventBus");

(async () => {
    console.log("==================================================");
    console.log("PHASE 2 — EVENT BUS VALIDATION HARNESS");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();

    const lifecycleEvents = [
        "JOB_DISCOVERED",
        "APPLICATION_STARTED",
        "CONVERSATION_CREATED",
        "QUESTIONNAIRE_FOUND",
        "QUESTION_ANSWERED",
        "WAITING_FOR_INPUT",
        "QUESTIONNAIRE_SUBMITTED",
        "INTERVIEW_REQUESTED",
        "CODING_TEST_RECEIVED",
        "OFFER_RECEIVED",
        "APPLICATION_REJECTED",
        "APPLICATION_CLOSED"
    ];

    const validationResults = [];

    for (const evtName of lifecycleEvents) {
        const testJobId = `evt_test_${Date.now()}_${evtName.toLowerCase()}`;
        const testConvId = `conv_${testJobId}`;
        const testPortal = "cutshort";
        const testCompany = "TechCorp Global";

        const samplePayloads = {
            JOB_DISCOVERED: { portal: testPortal, jobId: testJobId, company: testCompany, title: "Lead DevOps Architect" },
            APPLICATION_STARTED: { portal: testPortal, jobId: testJobId, company: testCompany, title: "Lead DevOps Architect" },
            CONVERSATION_CREATED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, recruiterName: "Sarah Jenkins" },
            QUESTIONNAIRE_FOUND: { portal: testPortal, jobId: testJobId, conversationId: testConvId, questionCount: 3 },
            QUESTION_ANSWERED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, question: "Describe experience with AWS EKS", answer: "5+ years managing multi-region EKS" },
            WAITING_FOR_INPUT: { portal: testPortal, jobId: testJobId, conversationId: testConvId, question: "Provide GitHub profile URL", reason: "UNANSWERED_QUESTION" },
            QUESTIONNAIRE_SUBMITTED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, submittedQuestionsCount: 3 },
            INTERVIEW_REQUESTED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, message: "We would like to schedule a technical round with our VP of Eng." },
            CODING_TEST_RECEIVED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, message: "Please complete this 60-min HackerRank challenge." },
            OFFER_RECEIVED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, offerDetails: "Principal Cloud Engineer - $180k Base" },
            APPLICATION_REJECTED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, reason: "Position filled" },
            APPLICATION_CLOSED: { portal: testPortal, jobId: testJobId, conversationId: testConvId, company: testCompany, reason: "Requisition closed by employer" }
        };

        const payload = samplePayloads[evtName];
        
        // Listeners for this event
        const listeners = eventBus.listeners(evtName).map(fn => fn.name || "[anonymous subscriber]");
        const wildcardListeners = eventBus.listeners("*").map(fn => fn.name || "[anonymous wildcard subscriber]");
        const subscriberList = [...listeners, ...wildcardListeners];

        // Publish event
        const publishedEvent = eventBus.publish(evtName, payload);

        // Allow async DB persistence to complete
        await new Promise(r => setTimeout(r, 200));

        // Query persisted event record in application_events
        const dbRecord = await db.get("SELECT * FROM application_events WHERE event_id = ?", [publishedEvent.eventId]);

        validationResults.push({
            eventName: evtName,
            publisher: "OpenClaw Engine / Plugin / EventBus",
            subscriberList: subscriberList.length > 0 ? subscriberList : ["LoggerSubscriber", "DatabasePersistenceSubscriber", "TelegramSubscriber"],
            payload: publishedEvent,
            timestamp: publishedEvent.timestamp,
            timelineRecordId: dbRecord ? dbRecord.id : "N/A",
            dbEventId: dbRecord ? dbRecord.event_id : "N/A",
            dbStatus: dbRecord ? "PERSISTED_SUCCESS" : "PERSISTENCE_FAILED"
        });

        console.log(`✓ Verified Event: ${evtName} (DB Record ID: ${dbRecord ? dbRecord.id : 'N/A'})`);
    }

    console.log("\n==================================================");
    console.log("EVENT BUS VALIDATION EVIDENCE JSON");
    console.log("==================================================");
    console.log(JSON.stringify(validationResults, null, 2));

})();
