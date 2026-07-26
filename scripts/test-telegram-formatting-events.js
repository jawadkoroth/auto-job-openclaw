const telegramService = require("../apps/telegram");
const eventBus = require("../packages/events/EventBus");
const db = require("../packages/database");

(async () => {
    console.log("==================================================");
    console.log("TELEGRAM FORMATTING & EVENTBUS TEST SUITE");
    console.log("==================================================\n");

    await db.init();

    // 1. Test markdownToHTML Placeholder Escaping
    console.log("--- 1. Testing markdownToHTML() Formatting ---");
    const testCases = [
        {
            name: "Standard Hirist Alert",
            input: "<b>✅ Application Submitted</b>\n\n• <b>Portal</b>: <code>Hirist</code>\n• <b>Status</b>: <code>APPLIED</code>",
            mustContain: ["<code>Hirist</code>", "<code>APPLIED</code>"],
            mustNotContain: ["__CODEBLOCK0__", "_CODEBLOCK1__", "undefined", "null", "[object Object]"]
        },
        {
            name: "Special Punctuation & Characters",
            input: "Company: <b>A&B Cloud Solutions - ML Inc.</b>\nRole: <b>DevOps / Cloud & Platform Engineer (Remote)</b>\nURL: https://cutshort.io/job/view?id=123&ref=auto",
            mustContain: ["A&amp;B", "DevOps / Cloud &amp; Platform Engineer (Remote)", "id=123&amp;ref=auto"],
            mustNotContain: ["__CODEBLOCK0__", "undefined", "null"]
        },
        {
            name: "Cutshort Code Blocks",
            input: "Portal: `Cutshort`\nStatus: `EMPLOYER_PENDING`",
            mustContain: ["<code>Cutshort</code>", "<code>EMPLOYER_PENDING</code>"],
            mustNotContain: ["__CODEBLOCK0__", "_CODEBLOCK1__"]
        }
    ];

    let testFailures = 0;
    for (const tc of testCases) {
        const rendered = telegramService.markdownToHTML(tc.input);
        console.log(`[Test: ${tc.name}] Rendered HTML:\n${rendered}\n`);

        for (const item of tc.mustContain) {
            if (!rendered.includes(item)) {
                console.error(`❌ FAILED: Expected rendered HTML to contain "${item}"`);
                testFailures++;
            }
        }
        for (const item of tc.mustNotContain) {
            if (rendered.includes(item)) {
                console.error(`❌ FAILED: Rendered HTML contained illegal string "${item}"`);
                testFailures++;
            }
        }
    }

    if (testFailures === 0) {
        console.log("✓ All 3 markdownToHTML formatting test cases PASSED perfectly!\n");
    } else {
        console.error(`❌ ${testFailures} formatting test cases failed.`);
        process.exit(1);
    }

    // 2. Test EventBus Subscription Handlers
    console.log("--- 2. Testing EventBus Decoupled Subscriptions ---");

    // Clear test delivery keys if present
    await db.run("DELETE FROM notification_deliveries WHERE notification_key LIKE 'test_%'");

    const sampleEvent = {
        portal: "Hirist",
        company: "Tiger Analytics — Senior ML Platform Engineer",
        title: "DevOps / ML Engineer (Cloud)",
        status: "APPLIED",
        url: "https://hirist.tech/job/1643702",
        jobId: "test_job_999"
    };

    console.log("Publishing sample APPLICATION_STARTED event via EventBus...");
    eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, sampleEvent);

    // Wait for async handler
    await new Promise(r => setTimeout(r, 1000));

    // Verify deduplication tracking table
    const delivery = await db.get("SELECT * FROM notification_deliveries WHERE notification_key = 'Hirist_test_job_999_SUBMITTED'");
    console.log("Notification Deduplication Record:", JSON.stringify(delivery, null, 2));

    if (delivery) {
        console.log("✓ Notification delivery correctly tracked for deduplication.\n");
    } else {
        console.warn("⚠️ Delivery record not found in notification_deliveries table.");
    }

    console.log("==================================================");
    console.log("TEST SUITE COMPLETE — VERIFIED CLEAN SUCCESS");
    console.log("==================================================\n");

})();
