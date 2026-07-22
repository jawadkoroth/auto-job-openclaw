const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs-extra");

async function runRegressionSuite() {
    console.log("==================================================");
    console.log("CANDIDATE KNOWLEDGE ORACLE SINGLE SOURCE E2E SUITE");
    console.log("==================================================\n");

    const db = require("../packages/database");
    const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
    const dashboardServer = require("../apps/dashboard/server");

    await db.init();

    // 1. Verify Database Single Source Connection
    assert.ok(db.getDbPath().includes("database.sqlite"), "Database path must point to single SQLite file");
    console.log("✅ Database Single Source: PASS");

    // 2. Candidate Profile Full CRUD Verification
    await candidateKnowledgeService.profile.updateProfile({ testKey: "testValue", email: "jawad@gmail.com", phone: "9876543210" });
    const profile = await candidateKnowledgeService.getProfile();
    assert.strictEqual(profile.email, "jawad@gmail.com", "Email must update");
    assert.strictEqual(profile.phone, "9876543210", "Phone must update");

    await candidateKnowledgeService.profile.deleteField("testKey");
    const rawFields = await candidateKnowledgeService.profile.getAllRawFields();
    assert.strictEqual(rawFields.some(r => r.key === "testKey"), false, "Deleted field must be removed");
    console.log("✅ Candidate Profile CRUD: PASS");

    // 3. Answer Bank Full CRUD Verification
    const ansId = await candidateKnowledgeService.answerBank.saveAnswer({
        question: "What is your DevOps experience?",
        answer: "5 years of DevOps experience",
        answerType: "FACTUAL"
    });
    assert.ok(ansId, "Answer ID must be returned");

    await candidateKnowledgeService.answerBank.updateAnswer(ansId, { answer: "6 years of DevOps experience" });
    const allAnswers = await candidateKnowledgeService.answerBank.getAllAnswers();
    const updatedAns = allAnswers.find(a => a.id === ansId);
    assert.strictEqual(updatedAns.approved_answer, "6 years of DevOps experience", "Answer must be updated");

    await candidateKnowledgeService.answerBank.deleteAnswer(ansId);
    const reloadedAns = await candidateKnowledgeService.answerBank.getAllAnswers();
    assert.strictEqual(reloadedAns.some(a => a.id === ansId), false, "Deleted answer must be removed");
    console.log("✅ Answer Bank CRUD: PASS");

    // 4. Single Default Active CV Strategy Verification
    const dummyPdfHeader = Buffer.from("%PDF-1.4 test resume content");
    const uploadedDocId = await candidateKnowledgeService.documentManager.uploadDefaultCv("test_single_default.pdf", dummyPdfHeader);
    assert.ok(uploadedDocId, "Uploaded document ID must exist");

    const defaultCv = await candidateKnowledgeService.documentManager.getDefaultResume();
    assert.strictEqual(defaultCv.documentId, uploadedDocId, "Uploaded CV must automatically become active default");

    const resumeSelector = require("../packages/resume/ResumeSelector");
    const selectedVariant = resumeSelector.selectResume("Senior DevOps Engineer", "AWS Docker Kubernetes");
    assert.strictEqual(selectedVariant, "default", "Resume selector must resolve to default for all jobs");

    await candidateKnowledgeService.documentManager.deleteDocument(uploadedDocId);
    console.log("✅ Single Default Active CV Strategy: PASS");

    // 5. Cover Letter Full CRUD Verification
    const clId = await candidateKnowledgeService.coverLetterManager.saveCoverLetter({
        title: "Default Software Engineer Cover",
        content: "Dear Hiring Manager, I am writing to express my interest...",
        isDefault: true
    });
    assert.ok(clId, "Cover letter ID must exist");

    const bestCl = await candidateKnowledgeService.coverLetterManager.getBestCoverLetter({ company: "Siemens" });
    assert.strictEqual(bestCl.found, true, "Best cover letter must be found");

    await candidateKnowledgeService.coverLetterManager.deleteCoverLetter(clId);
    console.log("✅ Cover Letter CRUD: PASS");

    // 6. Start Dashboard Server & Test HTTP Basic Authentication
    const PORT = 3006;
    const server = dashboardServer.listen(PORT, "127.0.0.1", async () => {
        // Test Unauthenticated request (must return 401)
        http.get(`http://127.0.0.1:${PORT}/api/stats`, (res) => {
            assert.strictEqual(res.statusCode, 401, "Unauthenticated request must return 401");

            // Test Authenticated request (must return 200)
            const authHeader = "Basic " + Buffer.from("admin:openclaw2026").toString("base64");
            const req = http.request(`http://127.0.0.1:${PORT}/api/stats`, {
                headers: { "Authorization": authHeader }
            }, (authRes) => {
                assert.strictEqual(authRes.statusCode, 200, "Authenticated request must return 200");
                console.log("✅ Dashboard Authentication Enforcement: PASS");

                server.close();
                console.log("\n==================================================");
                console.log("ALL CANDIDATE KNOWLEDGE ORACLE E2E TESTS PASSED");
                console.log("==================================================\n");
                process.exit(0);
            });
            req.end();
        });
    });
}

runRegressionSuite().catch(err => {
    console.error("❌ E2E Suite Failure:", err);
    process.exit(1);
});
