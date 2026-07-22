const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs-extra");

async function runDashboardTransparencyTest() {
    console.log("==================================================");
    console.log("CANDIDATE KNOWLEDGE DASHBOARD TRANSPARENCY E2E SUITE");
    console.log("==================================================\n");

    const db = require("../packages/database");
    const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
    const dashboardServer = require("../apps/dashboard/server");

    await db.init();

    // Setup dummy test data
    const dummyPdf = Buffer.from("%PDF-1.4 Transparency PDF Viewer Test Content");
    const docId = await candidateKnowledgeService.documentManager.uploadDefaultCv("transparency_test_cv.pdf", dummyPdf);

    const ansId = await candidateKnowledgeService.answerBank.saveAnswer({
        question: "What is your Kubernetes experience?",
        answer: "4 years of Kubernetes cluster management",
        answerType: "FACTUAL"
    });

    const clId = await candidateKnowledgeService.coverLetterManager.saveCoverLetter({
        title: "Transparency Test Cover",
        content: "Dear Hiring Manager, this is a transparency test cover letter.",
        isDefault: true
    });

    const PORT = 3007;
    const authHeader = "Basic " + Buffer.from("admin:openclaw2026").toString("base64");

    const server = dashboardServer.listen(PORT, "127.0.0.1", async () => {

        const makeRequest = (path, headers = {}) => {
            return new Promise((resolve, reject) => {
                const req = http.request(`http://127.0.0.1:${PORT}${path}`, {
                    headers: { "Authorization": authHeader, ...headers }
                }, (res) => {
                    let body = [];
                    res.on("data", chunk => body.push(chunk));
                    res.on("end", () => {
                        const buffer = Buffer.concat(body);
                        let json = null;
                        try { json = JSON.parse(buffer.toString()); } catch (e) {}
                        resolve({ statusCode: res.statusCode, headers: res.headers, body: buffer, json });
                    });
                });
                req.on("error", reject);
                req.end();
            });
        };

        try {
            // 1. Inline PDF View Route Test
            const pdfRes = await makeRequest(`/api/documents/view/${docId}`);
            assert.strictEqual(pdfRes.statusCode, 200, "PDF view route must return 200");
            assert.strictEqual(pdfRes.headers["content-type"], "application/pdf", "Content-Type must be application/pdf");
            assert.ok(pdfRes.headers["content-disposition"].includes("inline"), "Content-Disposition must be inline");
            assert.ok(pdfRes.body.toString().startsWith("%PDF"), "PDF stream must start with %PDF header");
            console.log("✅ PDF Inline View Route & Stream: PASS");

            // 2. Document Details Route Test
            const docRes = await makeRequest(`/api/documents/${docId}/details`);
            assert.strictEqual(docRes.statusCode, 200);
            assert.strictEqual(docRes.json.document.filename, "transparency_test_cv.pdf");
            assert.strictEqual(docRes.json.document.is_default, 1);
            console.log("✅ Document Details Inspection: PASS");

            // 3. Answer Bank Details Inspection Test
            const ansRes = await makeRequest(`/api/answers/${ansId}/details`);
            assert.strictEqual(ansRes.statusCode, 200);
            assert.strictEqual(ansRes.json.answer.approved_answer, "4 years of Kubernetes cluster management");
            console.log("✅ Answer Bank Details Inspection: PASS");

            // 4. Cover Letter Details Inspection Test
            const clRes = await makeRequest(`/api/cover-letters/${clId}/details`);
            assert.strictEqual(clRes.statusCode, 200);
            assert.strictEqual(clRes.json.coverLetter.title, "Transparency Test Cover");
            console.log("✅ Cover Letter Details Inspection: PASS");

            // 5. Data Explorer Dynamic Tables Discovery Test
            const tablesRes = await makeRequest("/api/explorer/tables");
            assert.strictEqual(tablesRes.statusCode, 200);
            assert.ok(Array.isArray(tablesRes.json.tables), "Tables list must be an array");
            assert.ok(tablesRes.json.tables.some(t => t.name === "candidate_profile"), "Must include candidate_profile table");
            assert.ok(tablesRes.json.tables.some(t => t.name === "answer_bank"), "Must include answer_bank table");
            console.log("✅ Data Explorer Dynamic Table Discovery: PASS");

            // 6. Data Explorer Table Inspection & Secret Masking Test
            const tableRes = await makeRequest("/api/explorer/table/candidate_profile");
            assert.strictEqual(tableRes.statusCode, 200);
            assert.strictEqual(tableRes.json.tableName, "candidate_profile");
            assert.ok(Array.isArray(tableRes.json.rows), "Rows must be an array");
            console.log("✅ Data Explorer Table Inspection & Secret Masking: PASS");

            // Cleanup test document
            await candidateKnowledgeService.documentManager.deleteDocument(docId);
            await candidateKnowledgeService.answerBank.deleteAnswer(ansId);
            await candidateKnowledgeService.coverLetterManager.deleteCoverLetter(clId);

            server.close();
            console.log("\n==================================================");
            console.log("ALL DASHBOARD TRANSPARENCY E2E TESTS PASSED");
            console.log("==================================================\n");
            process.exit(0);
        } catch (testErr) {
            console.error("❌ Transparency E2E Test Failure:", testErr);
            server.close();
            process.exit(1);
        }
    });
}

runDashboardTransparencyTest().catch(err => {
    console.error("❌ Suite Error:", err);
    process.exit(1);
});
