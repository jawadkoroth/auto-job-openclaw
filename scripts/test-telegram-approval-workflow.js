const assert = require("assert");
const db = require("../packages/database");
const Telegram = require("../apps/telegram");
const ApplicationQuestionEngine = require("../packages/ai/ApplicationQuestionEngine");
const ExternalAtsAutomation = require("../packages/automation/ExternalAtsAutomation");

async function runTests() {
    console.log("=================================================");
    console.log(" TELEGRAM APPROVAL WORKFLOW AUTOMATED TEST SUITE ");
    console.log("=================================================\n");

    await db.init();

    let passedCount = 0;
    let failedCount = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`[PASS] ${name}`);
            passedCount++;
        } catch (err) {
            console.error(`[FAIL] ${name}: ${err.message}`);
            failedCount++;
        }
    }

    async function asyncTest(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passedCount++;
        } catch (err) {
            console.error(`[FAIL] ${name}: ${err.message}`);
            failedCount++;
        }
    }

    // 1. Telegram HTML Rendering
    test("Telegram HTML Rendering: Preserves internal HTML tags and escapes user strings", () => {
        const rawTitle = "DevOps Engineer <Senior> & Lead";
        const rawCompany = "Canonical & Co.";
        const escapedTitle = Telegram.escapeHTML(rawTitle);
        const escapedCompany = Telegram.escapeHTML(rawCompany);

        assert.strictEqual(escapedTitle, "DevOps Engineer &lt;Senior&gt; &amp; Lead");
        assert.strictEqual(escapedCompany, "Canonical &amp; Co.");

        const msg = `⚠️ <b>Application Action Required</b>\n<b>Job:</b> ${escapedTitle}\n<code>/approve foundit-5283995-a81f2c</code>`;
        const rendered = Telegram.markdownToHTML(msg);

        assert.ok(rendered.includes("<b>Application Action Required</b>"), "Should preserve <b> tag");
        assert.ok(rendered.includes("<b>Job:</b>"), "Should preserve <b> tag for Job");
        assert.ok(rendered.includes("<code>/approve foundit-5283995-a81f2c</code>"), "Should preserve <code> tag");
        assert.ok(rendered.includes("&lt;Senior&gt;"), "Should keep escaped dynamic text");
        assert.ok(!rendered.includes("&lt;b&gt;"), "Should NOT escape valid HTML tags to &lt;b&gt;");
    });

    // 2. Duplicate Question Prevention & 3. Conflicting Suggestions Prevention
    await asyncTest("Duplicate Question Prevention & Conflicting Suggestions Prevention", async () => {
        const testJobId = "test-dedup-job-" + Date.now();
        const testPortal = "foundit";
        const questionText = "Disability Status";

        // Insert dummy job
        await db.run(
            "INSERT INTO jobs (portal, job_id, company, title, status) VALUES (?, ?, ?, ?, 'PENDING')",
            [testPortal, testJobId, "Canonical", "Software Engineer"]
        );

        const jobObj = { portal: testPortal, job_id: testJobId, company: "Canonical", title: "Software Engineer" };

        // First manual approval request (Decline to state)
        await ExternalAtsAutomation.requestManualApproval(jobObj, questionText, "Decline to state");

        const firstRecord = await db.get("SELECT * FROM jobs WHERE job_id = ?", [testJobId]);
        assert.strictEqual(firstRecord.status, "WAITING_FOR_INPUT");
        assert.strictEqual(firstRecord.pending_question, "Disability Status");
        assert.strictEqual(firstRecord.pending_suggested_answer, "Decline to state");

        // Second manual approval request for same job/question with CONFLICTING suggestion ("Yes")
        await ExternalAtsAutomation.requestManualApproval(jobObj, questionText, "Yes");

        const secondRecord = await db.get("SELECT * FROM jobs WHERE job_id = ?", [testJobId]);
        assert.strictEqual(secondRecord.status, "WAITING_FOR_INPUT");
        assert.strictEqual(secondRecord.pending_suggested_answer, "Decline to state", "Must NEVER overwrite existing pending answer");
    });

    // 4. Demographic Question Safety
    await asyncTest("Demographic Question Safety: Disability, Gender, Race, Veteran", async () => {
        const questions = [
            "Voluntary Disability Status",
            "Gender Identity",
            "Race and Ethnicity",
            "Veteran Status"
        ];

        for (const q of questions) {
            const isDemo = ApplicationQuestionEngine.isDemographicQuestion(q);
            assert.strictEqual(isDemo, true, `Question "${q}" must be identified as demographic`);

            const res = await ApplicationQuestionEngine.answerQuestion({
                question: q,
                jobId: "demo-test-123"
            });

            assert.strictEqual(res.status, "WAITING_FOR_INPUT", "Demographic questions must require WAITING_FOR_INPUT");
            assert.strictEqual(res.answer, "Decline to self-identify", "Demographic questions must suggest neutral default");
            assert.notStrictEqual(res.answer, "Yes", "Must NEVER suggest Yes for demographic question");
            assert.notStrictEqual(res.answer, "No", "Must NEVER suggest No for demographic question");
        }
    });

    // 5. AI-Prohibited Application Detection
    test("AI-Prohibited Application Detection: Canonical declaration clause", () => {
        const canonicalDeclaration = "During this application process I agree to use only my own words. I understand that plagiarism, the use of AI or other generated content will disqualify my application.";
        const isProhibited = ExternalAtsAutomation.detectAiProhibition(canonicalDeclaration);
        assert.strictEqual(isProhibited, true, "Must detect Canonical AI prohibition declaration");
    });

    // 6. AI Free-Text Generation Disabled When Prohibited
    await asyncTest("AI Free-Text Generation Disabled When Prohibited", async () => {
        const res = await ApplicationQuestionEngine.answerQuestion({
            question: "Why do you want to work at Canonical in your own words?",
            jobId: "ai-prohibited-test",
            aiContentProhibited: true
        });

        assert.strictEqual(res.status, "WAITING_FOR_INPUT");
        assert.strictEqual(res.type, "AI_PROHIBITED");
        assert.strictEqual(res.answer, "", "Must NOT generate AI answer when AI content is prohibited");
    });

    // 7. Unique Approval IDs
    test("Unique Approval IDs: Format portal-jobId-questionHash", () => {
        const approvalId = db.generateApprovalId("foundit", "5283995", "Disability Status");
        assert.ok(approvalId.startsWith("foundit-5283995-"), "Must start with portal-jobId");
        assert.strictEqual(approvalId.split("-").length, 3, "Must follow portal-jobId-hash format");
        assert.strictEqual(approvalId, "foundit-5283995-18be7f", "Must generate exact expected hash format");
    });

    // 8. Dry-Run Final Submission Protection
    test("Dry-Run Final Submission Protection: Prevent live submission in dry-run mode", () => {
        const config = require("../packages/config");
        const isDryRun = config.search.dryRun || !config.search.allowLiveApplications;
        assert.strictEqual(isDryRun, true, "Dry run / non-live mode must be active");
    });

    console.log("\n=================================================");
    console.log(` TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED `);
    console.log("=================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test runner exception:", err);
    process.exit(1);
});
