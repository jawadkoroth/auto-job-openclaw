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

        // --- 1. Inline PDF Streaming Route ---
        if (pathname.startsWith("/api/documents/view/") && method === "GET") {
            const docId = pathname.replace("/api/documents/view/", "");
            const doc = await db.get("SELECT * FROM documents WHERE document_id = ? OR id = ?", [docId, docId]);
            if (!doc || !fs.existsSync(doc.filepath)) {
                return sendJson(res, 404, { success: false, error: "CV document file not found." });
            }

            const stat = fs.statSync(doc.filepath);
            res.writeHead(200, {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${doc.filename}"`,
                "Content-Length": stat.size
            });

            const stream = fs.createReadStream(doc.filepath);
            return stream.pipe(res);
        }

        // --- 2. Document Details Route ---
        if (pathname.startsWith("/api/documents/") && pathname.endsWith("/details") && method === "GET") {
            const docId = pathname.replace("/api/documents/", "").replace("/details", "");
            const doc = await db.get("SELECT * FROM documents WHERE document_id = ? OR id = ?", [docId, docId]);
            if (!doc) return sendJson(res, 404, { success: false, error: "Document not found." });

            const fileExists = fs.existsSync(doc.filepath);
            const fileSize = fileExists ? fs.statSync(doc.filepath).size : 0;
            const snapshotCount = await db.get(
                "SELECT COUNT(*) as count FROM application_snapshots WHERE resume_document_id = ? OR resume_document_id = ?",
                [doc.document_id, doc.filename]
            ).catch(() => ({ count: 0 }));

            return sendJson(res, 200, {
                success: true,
                document: {
                    ...doc,
                    fileExists,
                    fileSize,
                    snapshotUsageCount: snapshotCount.count || 0
                }
            });
        }

        // --- 3. Overview & Stats Route ---
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

        // --- 3b. Portals Compatibility Matrix Route ---
        if (pathname === "/api/portals/matrix" && method === "GET") {
            const portalCounts = await db.all(
                `SELECT 
                    portal, 
                    COUNT(*) as total, 
                    SUM(CASE WHEN status='APPLIED' THEN 1 ELSE 0 END) as appliedCount,
                    SUM(CASE WHEN status='WAITING_FOR_INPUT' THEN 1 ELSE 0 END) as waitingCount,
                    SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) as failureCount,
                    MAX(timestamp) as lastRunTimestamp
                 FROM jobs GROUP BY portal`
            ).catch(() => []);

            const countsMap = {};
            for (const pc of portalCounts) {
                countsMap[(pc.portal || "").toLowerCase()] = {
                    total: pc.total || 0,
                    applied: pc.appliedCount || 0,
                    waiting: pc.waitingCount || 0,
                    failures: pc.failureCount || 0,
                    lastRun: pc.lastRunTimestamp || null
                };
            }

            const matrix = [
                { name: "Hirist", category: "India Tech", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Systemd", schedule: "10:00 AM & 2:00 PM IST", status: "ACTIVE", indiaEligible: true, remoteEligible: true },
                { name: "LinkedIn Jobs", category: "Global / India", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Intermediary / External ATS", schedule: "On-demand / Flow", status: "ACTIVE", indiaEligible: true, remoteEligible: true },
                { name: "Foundit", category: "India General", trust: "TRUSTED_WITH_CAUTION", oracleAccess: "Browser HTTP 403 (Cloudflare)", executionMode: "Local Discovery -> Oracle External ATS", schedule: "Local Discovery", status: "ACTIVE (EXTERNAL_ATS)", indiaEligible: true, remoteEligible: false },
                { name: "Instahyre", category: "India Tech", trust: "TRUSTED", oracleAccess: "PASS (Browser HTTP 200)", executionMode: "Oracle VM Playwright", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "Cutshort", category: "India Tech", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Browser / Native ATS", schedule: "On-demand", status: "VALIDATED", discoveryAutomation: "ACTIVE", appAutomation: "ACTIVE", indiaEligible: true, remoteEligible: true },
                { name: "Wellfound", category: "Global Startup / Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM External ATS", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "We Work Remotely", category: "Global Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM RSS / Intermediary", schedule: "12:00 PM IST (Discovery Only)", status: "DRY_RUN_VALIDATED", discoveryAutomation: "ACTIVE", appAutomation: "INACTIVE", indiaEligible: true, remoteEligible: true },
                { name: "Remote OK", category: "Global Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM API / ATS", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "Himalayas", category: "Global Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM API / ATS", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "NoDesk", category: "Global Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Feed / ATS", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "Working Nomads", category: "Global Remote", trust: "TRUSTED", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Feed / ATS", schedule: "On-demand", status: "READY_FOR_AUTOMATION", indiaEligible: true, remoteEligible: true },
                { name: "Shine", category: "India General", trust: "TRUSTED_WITH_CAUTION", oracleAccess: "PASS (HTTP 200)", executionMode: "Oracle VM Browser", schedule: "Manual", status: "DISCOVERY_ONLY", indiaEligible: true, remoteEligible: false },
                { name: "TimesJobs", category: "India General", trust: "TRUSTED_WITH_CAUTION", oracleAccess: "PASS (Browser HTTP 200)", executionMode: "Oracle VM Browser", schedule: "Manual", status: "DISCOVERY_ONLY", indiaEligible: true, remoteEligible: false },
                { name: "Remotive", category: "Global Remote", trust: "TRUSTED_WITH_CAUTION", oracleAccess: "FAIL (Cloudflare 403)", executionMode: "Local Discovery", schedule: "None", status: "BLOCKED_FROM_ORACLE", indiaEligible: true, remoteEligible: true },
                { name: "Indeed India", category: "Global / India", trust: "TRUSTED_WITH_CAUTION", oracleAccess: "FAIL (Security Check 403)", executionMode: "Local / Manual", schedule: "None", status: "BLOCKED_FROM_ORACLE", indiaEligible: true, remoteEligible: false },
                { name: "Glassdoor", category: "Global / India", trust: "TRUSTED", oracleAccess: "FAIL (Security Check 403)", executionMode: "Local / Manual", schedule: "None", status: "BLOCKED_FROM_ORACLE", indiaEligible: true, remoteEligible: false },
                { name: "Naukri", category: "India General", trust: "TRUSTED", oracleAccess: "Policy Disabled", executionMode: "Manual", schedule: "None", status: "MANUAL_APPLICATION_ONLY", indiaEligible: true, remoteEligible: false }
            ];

            const enriched = matrix.map(m => {
                const key = m.name.toLowerCase().replace(/[^a-z0-9]/g, "");
                const matchKey = Object.keys(countsMap).find(k => k.includes(key) || key.includes(k));
                const counts = matchKey ? countsMap[matchKey] : { total: 0, applied: 0, waiting: 0, failures: 0, lastRun: null };
                return {
                    ...m,
                    discoveredJobsCount: counts.total,
                    appliedJobsCount: counts.applied,
                    waitingForInputCount: counts.waiting,
                    failuresCount: counts.failures,
                    lastRun: counts.lastRun
                };
            });

            return sendJson(res, 200, { success: true, portals: enriched });
        }

        // --- 4. Candidate Profile Routes ---
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

        // --- 5. Answer Bank Routes ---
        if (pathname === "/api/answers" && method === "GET") {
            const answers = await candidateKnowledgeService.answerBank.getAllAnswers();
            return sendJson(res, 200, { success: true, answers });
        }

        if (pathname.startsWith("/api/answers/") && pathname.endsWith("/details") && method === "GET") {
            const id = pathname.replace("/api/answers/", "").replace("/details", "");
            const entry = await db.get("SELECT * FROM answer_bank WHERE id = ?", [id]);
            if (!entry) return sendJson(res, 404, { success: false, error: "Answer entry not found." });
            return sendJson(res, 200, { success: true, answer: entry });
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

        // --- 6. CV Document Routes ---
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

        // --- 7. Cover Letter Routes ---
        if (pathname === "/api/cover-letters" && method === "GET") {
            const letters = await candidateKnowledgeService.coverLetterManager.getAllCoverLetters();
            return sendJson(res, 200, { success: true, coverLetters: letters });
        }

        if (pathname.startsWith("/api/cover-letters/") && pathname.endsWith("/details") && method === "GET") {
            const id = pathname.replace("/api/cover-letters/", "").replace("/details", "");
            const letter = await db.get("SELECT * FROM cover_letters WHERE id = ? OR cover_letter_id = ?", [id, id]);
            if (!letter) return sendJson(res, 404, { success: false, error: "Cover letter not found." });
            return sendJson(res, 200, { success: true, coverLetter: letter });
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

        // --- 8. Pending Questions Routes ---
        if (pathname.startsWith("/api/pending/") && pathname.endsWith("/details") && method === "GET") {
            const jobId = pathname.replace("/api/pending/", "").replace("/details", "");
            const job = await db.get("SELECT * FROM jobs WHERE id = ? OR job_id = ?", [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: "Pending question record not found." });
            return sendJson(res, 200, { success: true, pendingQuestion: job });
        }

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

        // --- 9. Application Inspection & History Routes ---
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

        if (pathname.startsWith("/api/applications/") && pathname.endsWith("/details") && method === "GET") {
            const id = pathname.replace("/api/applications/", "").replace("/details", "");
            const job = await db.get("SELECT * FROM jobs WHERE id = ? OR job_id = ?", [id, id]);
            if (!job) return sendJson(res, 404, { success: false, error: "Application record not found." });

            const snapshot = await db.get("SELECT * FROM application_snapshots WHERE job_id = ? ORDER BY id DESC LIMIT 1", [job.job_id || job.id]).catch(() => null);

            let parsedSnapshot = null;
            if (snapshot) {
                try {
                    parsedSnapshot = {
                        ...snapshot,
                        candidate_profile_snapshot: snapshot.candidate_profile_snapshot ? JSON.parse(snapshot.candidate_profile_snapshot) : null,
                        answer_bank_ids_used: snapshot.answer_bank_ids_used ? JSON.parse(snapshot.answer_bank_ids_used) : [],
                        one_time_answers_used: snapshot.one_time_answers_used ? JSON.parse(snapshot.one_time_answers_used) : []
                    };
                } catch (e) {
                    parsedSnapshot = snapshot;
                }
            }

            return sendJson(res, 200, { success: true, application: job, snapshot: parsedSnapshot });
        }

        if (pathname.startsWith("/api/applications/") && method === "DELETE") {
            const id = pathname.replace("/api/applications/", "");
            await db.run("DELETE FROM jobs WHERE id = ? OR job_id = ?", [id, id]);
            return sendJson(res, 200, { success: true, message: "Application record deleted." });
        }

        // --- 10. Data Explorer Routes (Read-Only & Secret Masked) ---
        if (pathname === "/api/explorer/tables" && method === "GET") {
            const rawTables = await db.all(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).catch(() => []);

            const allowedTables = [];
            for (const t of rawTables) {
                const name = t.name;
                // Exclude system/session/token tables if present
                if (name.toLowerCase().includes("session") || name.toLowerCase().includes("token")) continue;
                const countRow = await db.get(`SELECT COUNT(*) as count FROM "${name}"`).catch(() => ({ count: 0 }));
                allowedTables.push({ name, rowCount: countRow.count || 0 });
            }

            return sendJson(res, 200, { success: true, tables: allowedTables });
        }

        if (pathname.startsWith("/api/explorer/table/") && method === "GET") {
            const tableName = pathname.replace("/api/explorer/table/", "");
            
            // Validate table name against sqlite_master (prevents SQL injection)
            const validTable = await db.get(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                [tableName]
            );
            if (!validTable) {
                return sendJson(res, 404, { success: false, error: "Table not found." });
            }

            // Get columns info
            const tableInfo = await db.all(`PRAGMA table_info("${tableName}")`).catch(() => []);
            const columns = tableInfo.map(c => c.name);

            // Pagination parameters
            const page = parseInt(parsedUrl.query.page || "1", 10);
            const limit = parseInt(parsedUrl.query.limit || "25", 10);
            const offset = (page - 1) * limit;

            const totalRow = await db.get(`SELECT COUNT(*) as count FROM "${tableName}"`).catch(() => ({ count: 0 }));
            const rows = await db.all(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`, [limit, offset]).catch(() => []);

            // Backend Security Data Masking
            const sensitiveKeywords = [
                "password", "pass", "token", "secret", "cookie", "session", "auth",
                "otp", "storagestate", "bot_token", "access_token", "refresh_token", "openrouter"
            ];

            const maskedRows = rows.map(row => {
                const cleanRow = { ...row };
                for (const col of Object.keys(cleanRow)) {
                    const colLower = col.toLowerCase();
                    if (sensitiveKeywords.some(kw => colLower.includes(kw))) {
                        cleanRow[col] = "***MASKED***";
                    }
                }
                return cleanRow;
            });

            return sendJson(res, 200, {
                success: true,
                tableName,
                columns,
                totalRows: totalRow.count || 0,
                page,
                limit,
                rows: maskedRows
            });
        }

        // --- 11. Cutshort Conversation Flow & Metrics Endpoint ---
        if (pathname === "/api/cutshort/conversations" && method === "GET") {
            const cutshortJobs = await db.all("SELECT * FROM jobs WHERE portal = 'cutshort' ORDER BY id DESC").catch(() => []);
            const metrics = {
                total: cutshortJobs.length,
                conversationCreated: cutshortJobs.filter(j => j.status === "CONVERSATION_CREATED").length,
                questionnairePending: cutshortJobs.filter(j => j.status === "QUESTIONNAIRE_PENDING" || j.status === "QUESTIONNAIRE_IN_PROGRESS").length,
                questionnaireSubmitted: cutshortJobs.filter(j => j.status === "QUESTIONNAIRE_SUBMITTED" || j.questionnaire_status === "QUESTIONNAIRE_SUBMITTED").length,
                applicationSubmitted: cutshortJobs.filter(j => j.status === "APPLICATION_SUBMITTED" || j.status === "APPLIED").length,
                employerWaiting: cutshortJobs.filter(j => j.status === "EMPLOYER_PENDING").length,
                interviewRequested: cutshortJobs.filter(j => j.status === "INTERVIEW_REQUESTED").length,
                waitingForInput: cutshortJobs.filter(j => j.status === "WAITING_FOR_INPUT").length,
                closed: cutshortJobs.filter(j => j.status === "CLOSED" || j.status === "REJECTED").length
            };

            return sendJson(res, 200, {
                success: true,
                metrics,
                conversations: cutshortJobs
            });
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
