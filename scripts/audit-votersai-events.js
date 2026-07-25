const db = require("../packages/database");

(async () => {
    await db.init();
    const rows = await db.all(
        "SELECT * FROM application_events WHERE portal = 'cutshort' AND job_id = 'DevOps-Platform-Reliability-Engineer-Full-time-Pune-VotersAI-PdmmkhU1' ORDER BY id ASC"
    );

    console.log("==================================================");
    console.log("VOTERSAI APPLICATION EVENTS AUDIT (5 ROWS)");
    console.log("==================================================\n");

    rows.forEach((r, idx) => {
        let payloadSummary = "";
        try {
            const p = JSON.parse(r.payload);
            payloadSummary = JSON.stringify(p);
        } catch (e) {
            payloadSummary = r.payload;
        }

        console.log(`[${idx + 1}] Event ID:       ${r.id}`);
        console.log(`    Timestamp:      ${r.timestamp}`);
        console.log(`    Event Type:     ${r.event_type}`);
        console.log(`    Job ID:         ${r.job_id}`);
        console.log(`    Conversation ID:${r.conversation_id || "N/A"}`);
        console.log(`    Payload:        ${payloadSummary}\n`);
    });
})();
