const http = require("http");
const path = require("path");
const fs = require("fs");
const url = require("url");
const db = require("../../packages/database");
const candidateKnowledgeService = require("../../packages/knowledge/CandidateKnowledgeService");

const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3005;
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "openclaw2026";

function authenticate(req, res) {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
        res.writeHead(401, {
            "WWW-Authenticate": 'Basic realm="Candidate Knowledge Admin"',
            "Content-Type": "application/json"
        });
        res.end(JSON.stringify({ success: false, error: "Authentication required" }));
        return false;
    }

    const auth = Buffer.from(authHeader.split(" ")[1] || "", "base64").toString().split(":");
    const user = auth[0];
    const pass = auth[1];

    if (user === DASHBOARD_USER && pass === DASHBOARD_PASSWORD) {
        return true;
    }

    res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Candidate Knowledge Admin"',
        "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ success: false, error: "Invalid credentials" }));
    return false;
}

function parseJsonBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                resolve(JSON.parse(body || "{}"));
            } catch (e) {
                resolve({});
            }
        });
    });
}

function parseRawBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", err => reject(err));
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
        } else {
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        }
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS & Content-Type headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    // Require HTTP Basic Auth for all API & Admin UI routes
    if (!authenticate(req, res)) {
        return;
    }

    try {
        await db.init();

        // --- API Stats Route ---
        if (pathname === "/api/stats" && method === "GET") {
            const totalApps = await db.get("SELECT COUNT(*) as count FROM jobs WHERE status = 'APPLIED'").catch(() => ({ count: 0 }));
            const pendingQuestions = await db.all("SELECT * FROM jobs WHERE status = 'WAITING_FOR_INPUT' ORDER BY id DESC").catch(() => []);
            const answersCount = await db.get("SELECT COUNT(*) as count FROM answer_bank").catch(() => ({ count: 0 }));
            const defaultCv = await candidateKnowledgeService.documentManager.getDefaultResume().catch(() => null);
            const sanitized = await candidateKnowledgeService.profile.getSanitizedProfileStatus();
            const readiness = await candidateKnowledgeService.profile.checkPreLiveProfileReadiness();

            return sendJson(res, 200, {
                success: true,
                totalApplications: totalApps.count || 0,
                pendingQuestionsCount: pendingQuestions.length,
                pendingQuestions,
                answerBankCount: answersCount.count || 0,
                defaultCvFilename: defaultCv ? defaultCv.filename : "None",
                profileStatus: sanitized,
                isProfileReady: readiness.isReady,
                missingRequiredFields: readiness.missingRequiredFields
            });
        }

        // --- Candidate Profile CRUD ---
        if (pathname === "/api/profile" && method === "GET") {
            const profile = await candidateKnowledgeService.getProfile();
            const rawFields = await candidateKnowledgeService.profile.getAllRawFields();
            return sendJson(res, 200, { success: true, profile, rawFields });
        }

        if (pathname === "/api/profile" && method === "POST") {
            const body = await parseJsonBody(req);
            await candidateKnowledgeService.profile.updateProfile(body);
            return sendJson(res, 200, { success: true, message: "Candidate profile updated successfully." });
        }

        if (pathname.startsWith("/api/profile/") && method === "DELETE") {
            const key = decodeURIComponent(pathname.replace("/api/profile/", ""));
            await candidateKnowledgeService.profile.deleteField(key);
            return sendJson(res, 200, { success: true, message: `Field "${key}" deleted.` });
        }

        // --- Answer Bank CRUD ---
        if (pathname === "/api/answers" && method === "GET") {
            const answers = await candidateKnowledgeService.answerBank.getAllAnswers();
            return sendJson(res, 200, { success: true, answers });
        }

        if (pathname === "/api/answers" && method === "POST") {
            const body = await parseJsonBody(req);
            const id = await candidateKnowledgeService.answerBank.saveAnswer(body);
            return sendJson(res, 200, { success: true, id, message: "Answer Bank entry created." });
        }

        if (pathname.startsWith("/api/answers/") && method === "PUT") {
            const id = pathname.replace("/api/answers/", "");
            const body = await parseJsonBody(req);
            await candidateKnowledgeService.answerBank.updateAnswer(id, body);
            return sendJson(res, 200, { success: true, message: "Answer Bank entry updated." });
        }

        if (pathname.startsWith("/api/answers/") && method === "DELETE") {
            const id = pathname.replace("/api/answers/", "");
            await candidateKnowledgeService.answerBank.deleteAnswer(id);
            return sendJson(res, 200, { success: true, message: "Answer Bank entry deleted." });
        }

        // --- Single Default CV / Document Manager ---
        if (pathname === "/api/documents" && method === "GET") {
            const docs = await candidateKnowledgeService.documentManager.getAllDocuments();
            const defaultCv = await candidateKnowledgeService.documentManager.getDefaultResume();
            return sendJson(res, 200, { success: true, documents: docs, defaultCv });
        }

        if (pathname === "/api/documents/upload" && method === "POST") {
            const body = await parseJsonBody(req);
            if (!body.filename || !body.base64Data) {
                return sendJson(res, 400, { success: false, error: "Filename and base64Data are required." });
            }
            const buffer = Buffer.from(body.base64Data, "base64");
            const documentId = await candidateKnowledgeService.documentManager.uploadDefaultCv(body.filename, buffer);
            return sendJson(res, 200, { success: true, documentId, message: "New default CV uploaded successfully." });
        }

        if (pathname === "/api/documents/default" && method === "POST") {
            const body = await parseJsonBody(req);
            await candidateKnowledgeService.documentManager.setDefault(body.documentId);
            return sendJson(res, 200, { success: true, message: "Default production CV set." });
        }

        if (pathname.startsWith("/api/documents/") && method === "DELETE") {
            const docId = pathname.replace("/api/documents/", "");
            await candidateKnowledgeService.documentManager.deleteDocument(docId);
            return sendJson(res, 200, { success: true, message: "CV document deleted/archived." });
        }

        // --- Cover Letter CRUD ---
        if (pathname === "/api/cover-letters" && method === "GET") {
            const letters = await candidateKnowledgeService.coverLetterManager.getAllCoverLetters();
            return sendJson(res, 200, { success: true, coverLetters: letters });
        }

        if (pathname === "/api/cover-letters" && method === "POST") {
            const body = await parseJsonBody(req);
            const id = await candidateKnowledgeService.coverLetterManager.saveCoverLetter(body);
            return sendJson(res, 200, { success: true, id, message: "Cover letter saved." });
        }

        if (pathname.startsWith("/api/cover-letters/") && method === "PUT") {
            const id = pathname.replace("/api/cover-letters/", "");
            const body = await parseJsonBody(req);
            await candidateKnowledgeService.coverLetterManager.updateCoverLetter(id, body);
            return sendJson(res, 200, { success: true, message: "Cover letter updated." });
        }

        if (pathname.startsWith("/api/cover-letters/") && method === "DELETE") {
            const id = pathname.replace("/api/cover-letters/", "");
            await candidateKnowledgeService.coverLetterManager.deleteCoverLetter(id);
            return sendJson(res, 200, { success: true, message: "Cover letter deleted." });
        }

        // --- Pending Questions Management ---
        if (pathname === "/api/pending/resolve" && method === "POST") {
            const body = await parseJsonBody(req);
            const job = await db.get("SELECT * FROM jobs WHERE id = ? OR job_id = ?", [body.jobId, body.jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: "Job not found" });

            if (body.saveForFuture && job.pending_question) {
                await candidateKnowledgeService.answerBank.saveAnswer({
                    question: job.pending_question,
                    answer: body.answer,
                    answerType: "FACTUAL"
                });
            }

            await db.run(
                "UPDATE jobs SET status = 'ELIGIBLE', pending_question = NULL, pending_suggested_answer = NULL, pending_question_id = NULL, approval_id = NULL WHERE id = ?",
                [job.id]
            );

            return sendJson(res, 200, { success: true, message: `Question resolved for ${job.company || 'Job'}. Marked ELIGIBLE.` });
        }

        if (pathname.startsWith("/api/pending/") && method === "DELETE") {
            const jobId = pathname.replace("/api/pending/", "");
            await db.run(
                "UPDATE jobs SET status = 'CANCELLED', pending_question = NULL, pending_suggested_answer = NULL, pending_question_id = NULL, approval_id = NULL WHERE id = ? OR job_id = ?",
                [jobId, jobId]
            );
            return sendJson(res, 200, { success: true, message: "Pending question request cancelled." });
        }

        // --- Application History & Filtering ---
        if (pathname === "/api/applications" && method === "GET") {
            const statusFilter = parsedUrl.query.status;
            let sql = "SELECT * FROM jobs";
            const params = [];

            if (statusFilter && statusFilter !== "ALL") {
                sql += " WHERE status = ?";
                params.push(statusFilter);
            }

            sql += " ORDER BY id DESC LIMIT 200";
            const jobs = await db.all(sql, params).catch(() => []);
            return sendJson(res, 200, { success: true, applications: jobs });
        }

        if (pathname.startsWith("/api/applications/") && method === "DELETE") {
            const id = pathname.replace("/api/applications/", "");
            await db.run("DELETE FROM jobs WHERE id = ? OR job_id = ?", [id, id]);
            return sendJson(res, 200, { success: true, message: "Application record deleted." });
        }

        // --- Serve Static Dashboard Files ---
        if (pathname === "/" || pathname === "/index.html") {
            return serveStatic(res, path.join(__dirname, "public", "index.html"), "text/html");
        }

        sendJson(res, 404, { success: false, error: "Not Found" });
    } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
    }
});

if (require.main === module) {
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`[Dashboard] Authenticated Candidate Knowledge Dashboard running at http://0.0.0.0:${PORT}`);
    });
}

module.exports = server;
