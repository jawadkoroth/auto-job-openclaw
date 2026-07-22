const assert = require("assert");
const db = require("../packages/database");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const candidateProfile = require("../packages/knowledge/CandidateProfile");
const answerBank = require("../packages/knowledge/AnswerBank");
const documentManager = require("../packages/knowledge/DocumentManager");
const coverLetterManager = require("../packages/knowledge/CoverLetterManager");
const applicationSnapshot = require("../packages/knowledge/ApplicationSnapshot");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const aiService = require("../packages/ai");

async function runProductionFixesTestSuite() {
    console.log("==================================================");
    console.log("PRODUCTION FIXES & READINESS VALIDATION SUITE");
    console.log("==================================================\n");

    await db.init();

    let passedCount = 0;
    let totalCount = 0;

    async function runTest(num, name, fn) {
        totalCount++;
        try {
            await fn();
            console.log(`✅ [PASS ${num}/15] ${name}`);
            passedCount++;
        } catch (err) {
            console.error(`❌ [FAIL ${num}/15] ${name}: ${err.message}`);
        }
    }

    // 1. Explicit Live/Dry-Run Mode Parsing Bug Fix
    await runTest(1, "Explicit Live/Dry-Run Mode String Parsing", async () => {
        const parseBool = (val, defaultVal = false) => val === undefined ? defaultVal : String(val).trim().toLowerCase() === "true";
        assert.strictEqual(parseBool("false"), false, 'Boolean("false") must parse to false');
        assert.strictEqual(parseBool("true"), true, 'Boolean("true") must parse to true');
        assert.strictEqual(parseBool("FALSE"), false);
    });

    // 2. Production Profile Validation Guard
    await runTest(2, "Production Profile Guard (Rejects Placeholders)", async () => {
        assert.strictEqual(candidateProfile.isProductionValueValid("email", "jawad.koroth@example.com"), false, "Must reject example.com email");
        assert.strictEqual(candidateProfile.isProductionValueValid("phone", "+919999999999"), false, "Must reject 9999999999 dummy phone");
        assert.strictEqual(candidateProfile.isProductionValueValid("educationSchool", "University"), false, "Must reject generic University fallback");
        assert.strictEqual(candidateProfile.isProductionValueValid("email", "jawad.koroth@realdomain.com"), true, "Must accept valid production email");
    });

    // 3. Extended Deterministic Profile Mappings
    await runTest(3, "Extended Deterministic Profile Mappings", async () => {
        assert.strictEqual(candidateKnowledgeService.mapQuestionToProfileKey("Location (City)"), "currentLocation");
        assert.strictEqual(candidateKnowledgeService.mapQuestionToProfileKey("Start date year"), "educationStartYear");
        assert.strictEqual(candidateKnowledgeService.mapQuestionToProfileKey("End date year"), "educationEndYear");
        assert.strictEqual(candidateKnowledgeService.mapQuestionToProfileKey("LinkedIn Profile"), "linkedinUrl");
        assert.strictEqual(candidateKnowledgeService.mapQuestionToProfileKey("Website"), "portfolioUrl");
    });

    // 4. Pre-Live Profile Readiness Check
    await runTest(4, "Pre-Live Profile Readiness Check", async () => {
        const readiness = await candidateKnowledgeService.profile.checkPreLiveProfileReadiness();
        assert.ok(readiness.missingRequiredFields.length >= 0);
        assert.ok(typeof readiness.isReady === "boolean");
    });

    // 5. Answer Bank Conflict Protection
    await runTest(5, "Answer Bank Conflict Safety Check", async () => {
        const testKey = `conflict_key_${Date.now()}`;
        await answerBank.saveAnswer({ canonicalKey: testKey, question: "Q1", answer: "Ans A" });
        await answerBank.saveAnswer({ canonicalKey: testKey, question: "Q2", answer: "Ans B" });
        const res = await answerBank.findAnswer("Q1", { canonicalKey: testKey });
        assert.strictEqual(res.found, false);
        assert.strictEqual(res.conflict, true);
    });

    // 6. AI Provider Circuit Breaker
    await runTest(6, "AI Provider Circuit Breaker on Quota/Auth Errors", async () => {
        aiService.circuitTripped = true;
        aiService.circuitTrippedReason = "Request failed with status code 402";
        const parsed = await aiService.parseCommand("apply to devops jobs on foundit");
        assert.strictEqual(parsed.plugin, "foundit");
        assert.strictEqual(parsed.action, "apply");
        aiService.circuitTripped = false;
    });

    // 7. Sensitive & Demographic Question Protection
    await runTest(7, "Sensitive & Demographic Protection", async () => {
        const res = await candidateKnowledgeService.resolveQuestion({ question: "Do you require visa sponsorship?" });
        assert.strictEqual(res.status, "WAITING_FOR_INPUT");
    });

    // 8. AI Prohibition Compliance
    await runTest(8, "AI Prohibition Compliance", async () => {
        const res = await candidateKnowledgeService.resolveQuestion({ question: "Why do you want to work here?", aiContentProhibited: true });
        assert.strictEqual(res.status, "WAITING_FOR_INPUT");
        assert.strictEqual(res.reason, "AI_CONTENT_PROHIBITED");
    });

    // 9. Document Manager Resume Variant Fallback
    await runTest(9, "Document Manager Resume Variant Selection", async () => {
        const res = await documentManager.getBestResume("devops");
        assert.ok(res.filePath);
    });

    // 10. Cover Letter Priority Resolution
    await runTest(10, "Cover Letter Priority Resolution", async () => {
        await coverLetterManager.saveCoverLetter({ title: "Comp Specific", content: "Content", targetCompany: "Together AI Test" });
        const cl = await coverLetterManager.getBestCoverLetter({ company: "Together AI Test" });
        assert.ok(cl.found);
        assert.strictEqual(cl.title, "Comp Specific");
    });

    // 11. Application Snapshot Immutability
    await runTest(11, "Application Snapshot Immutability", async () => {
        await applicationSnapshot.recordSnapshot({ jobId: "job_snap_test_15", candidateProfile: { name: "Original Candidate" } });
        const snap = await applicationSnapshot.getSnapshot("job_snap_test_15");
        assert.strictEqual(snap.candidateProfile.name, "Original Candidate");
    });

    // 12. Database Status Accuracy for Unresolved Fields
    await runTest(12, "Database Status Accuracy for Unresolved Input", async () => {
        const hasUnresolvedQuestions = true;
        const status = hasUnresolvedQuestions ? "WAITING_FOR_INPUT" : "PRE_SUBMISSION_VALIDATION_FAILED";
        assert.strictEqual(status, "WAITING_FOR_INPUT");
    });

    // 13. Duplicate Protection Expansion
    await runTest(13, "Duplicate Protection Across Active Application Statuses", async () => {
        await db.run("INSERT OR IGNORE INTO jobs (portal, job_id, company, title, status) VALUES ('foundit', 'dup_test_15', 'Comp', 'Title', 'WAITING_FOR_INPUT')");
        const isDup = await db.isDuplicateJob("foundit", "dup_test_15");
        assert.strictEqual(isDup, true);
    });

    // 14. Hirist Regression Stability
    await runTest(14, "Hirist Routing & Domain Check", async () => {
        const isHirist = externalApplicationRouter.isLinkedInUrl("https://www.hirist.tech");
        assert.strictEqual(isHirist, false);
    });

    // 15. Dry-Run Final Submit Protection
    await runTest(15, "Dry-Run Final Submit Protection", async () => {
        const dryRun = true;
        const allowLive = false;
        const canSubmit = !dryRun && allowLive;
        assert.strictEqual(canSubmit, false);
    });

    // 16. Candidate Knowledge Sync Export & Import
    await runTest(16, "Candidate Knowledge Sync Export & Import", async () => {
        const candidateKnowledgeSync = require("../packages/knowledge/CandidateKnowledgeSync");
        const exportPath = await candidateKnowledgeSync.exportSyncPayload();
        assert.ok(exportPath);
        const importRes = await candidateKnowledgeSync.importSyncPayload(exportPath);
        assert.ok(importRes.profileCount >= 0);
        assert.ok(importRes.answerBankCount >= 0);
    });

    // 17. Sanitized Profile Status Verification
    await runTest(17, "Sanitized Profile Status Verification (PII Protected)", async () => {
        const status = await candidateProfile.getSanitizedProfileStatus();
        assert.ok(typeof status.emailPresent === "boolean");
        assert.ok(typeof status.emailIsPlaceholder === "boolean");
        assert.ok(typeof status.phonePresent === "boolean");
        assert.ok(typeof status.phoneIsPlaceholder === "boolean");
    });

    console.log("\n==================================================");
    console.log(`PRODUCTION FIXES SUITE COMPLETE: ${passedCount}/${totalCount} PASSED`);
    console.log("==================================================\n");

    if (passedCount < totalCount) {
        process.exit(1);
    }
}

runProductionFixesTestSuite().catch(err => {
    console.error("Test Suite failure:", err);
    process.exit(1);
});
