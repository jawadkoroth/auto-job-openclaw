const aiService = require("../packages/ai");
const db = require("../packages/database");
const taskQueue = require("../packages/queue/TaskQueue");

async function runTests() {
    console.log("=========================================");
    console.log("   INTENT ROUTER REGRESSION TEST SUITE   ");
    console.log("=========================================\n");

    await db.init();

    const conversationalMessages = [
        "hi",
        "hello",
        "hey",
        "how are you?",
        "thanks",
        "what is kubernetes?",
        "explain AWS VPC"
    ];

    let passed = 0;
    let failed = 0;

    console.log("--- TEST 1: CONVERSATIONAL & TECHNICAL MESSAGES ---");
    for (const msg of conversationalMessages) {
        const classification = await aiService.classifyIntent(msg);
        const isConv = classification.intent === "CONVERSATION";
        if (isConv) {
            console.log(`✅ Message "${msg}" -> CONVERSATION (Passed)`);
            passed++;
        } else {
            console.error(`❌ Message "${msg}" -> ${classification.intent} (FAILED - Expected CONVERSATION)`);
            failed++;
        }
    }

    console.log("\n--- TEST 2: EXPLICIT AUTOMATION MESSAGES ---");
    const automationMessages = [
        "Apply for DevOps jobs on Hirist",
        "Find Cloud Engineer jobs on Hirist"
    ];

    for (const msg of automationMessages) {
        const classification = await aiService.classifyIntent(msg);
        const isAuto = classification.intent === "AUTOMATION";
        const parsed = await aiService.parseCommand(msg);
        if (isAuto && parsed && parsed.plugin && parsed.action) {
            console.log(`✅ Message "${msg}" -> AUTOMATION [${parsed.plugin}.${parsed.action}] (Passed)`);
            passed++;
        } else {
            console.error(`❌ Message "${msg}" -> ${classification.intent} (FAILED - Expected AUTOMATION)`);
            failed++;
        }
    }

    console.log("\n--- TEST 3: AMBIGUOUS MESSAGE ---");
    const ambiguousMsg = "jobs";
    const ambClassification = await aiService.classifyIntent(ambiguousMsg);
    if (ambClassification.intent === "AMBIGUOUS") {
        console.log(`✅ Message "${ambiguousMsg}" -> AMBIGUOUS (Passed)`);
        passed++;
    } else {
        console.error(`❌ Message "${ambiguousMsg}" -> ${ambClassification.intent} (FAILED - Expected AMBIGUOUS)`);
        failed++;
    }

    console.log("\n--- TEST 4: FAIL-CLOSED SAFETY CHECK ---");
    const fallbackRes = aiService.ruleBasedFallback("random normal conversation without automation intent");
    if (fallbackRes === null) {
        console.log(`✅ Rule-based fallback returned NULL for generic conversation (Passed - Fails Closed)`);
        passed++;
    } else {
        console.error(`❌ Rule-based fallback returned task payload: ${JSON.stringify(fallbackRes)} (FAILED - Did not fail closed!)`);
        failed++;
    }

    console.log("\n=========================================");
    console.log(`TEST SUMMARY: Passed: ${passed}, Failed: ${failed}`);
    console.log("=========================================");

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
