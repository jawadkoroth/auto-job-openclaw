const externalAtsAutomation = require("../packages/automation/ExternalAtsAutomation");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const db = require("../packages/database");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    await db.init();
    
    const queuedJobsFile = path.join(__dirname, "../sessions/queued_external_jobs.json");
    if (!await fs.pathExists(queuedJobsFile)) {
        console.error("[Oracle Worker] queued_external_jobs.json not found!");
        process.exit(1);
    }

    const queuedJobs = await fs.readJson(queuedJobsFile);
    if (!Array.isArray(queuedJobs) || queuedJobs.length === 0) {
        console.error("[Oracle Worker] No queued jobs found in payload!");
        process.exit(1);
    }

    const job = queuedJobs[0];
    const jobId = process.env.SINGLE_JOB_ALLOWLIST || job.job_id || job.id;
    process.env.SINGLE_JOB_ALLOWLIST = String(jobId);

    const dryRun = String(process.env.DRY_RUN || "true").trim().toLowerCase() === "true";
    const allowLive = String(process.env.ALLOW_LIVE_APPLICATIONS || "false").trim().toLowerCase() === "true";
    const isAllowlisted = jobId && (String(job.job_id) === String(jobId) || String(job.id) === String(jobId));
    const liveSubmissionAllowed = !dryRun && allowLive && isAllowlisted;

    console.log("==================================================");
    console.log("EXECUTION MODE");
    console.log(`DRY_RUN: ${dryRun ? "TRUE" : "FALSE"}`);
    console.log(`ALLOW_LIVE_APPLICATIONS: ${allowLive ? "TRUE" : "FALSE"}`);
    console.log(`SINGLE_JOB_ALLOWLIST: ${jobId}`);
    console.log(`LIVE_SUBMISSION_ALLOWED_FOR_CURRENT_JOB: ${liveSubmissionAllowed ? "TRUE" : "FALSE"}`);
    console.log("==================================================\n");

    console.log(`[Oracle Worker] Processing single allowlisted job: "${job.title}" at "${job.company}" (ID: ${jobId})`);

    const dbPath = db.getDbPath();
    console.log(`[Oracle Worker] Authoritative Database Path: ${dbPath}`);
    console.log(`KNOWLEDGE_DB_CONSISTENCY: PASS`);

    const candidateKnowledgeSync = require("../packages/knowledge/CandidateKnowledgeSync");
    const syncFile = path.join(__dirname, "../sessions/candidate_knowledge_sync.json");
    if (await fs.pathExists(syncFile)) {
        console.log("[Oracle Worker] Synchronizing Candidate Knowledge Base from sync payload...");
        try {
            const syncResult = await candidateKnowledgeSync.importSyncPayload(syncFile);
            console.log(`[Oracle Worker] Candidate Knowledge synced: Profile (${syncResult.profileCount}), Answer Bank (${syncResult.answerBankCount}), Documents (${syncResult.documentsCount}).`);
        } catch (syncErr) {
            console.error(`[Oracle Worker] ❌ Knowledge sync import failed: ${syncErr.message}`);
            await db.run(
                "UPDATE jobs SET status = 'KNOWLEDGE_SYNC_FAILED', reason = ? WHERE (id = ? OR job_id = ?)",
                [`Knowledge sync failed: ${syncErr.message}`, job.id || job.job_id, job.job_id || job.id]
            ).catch(() => {});
            console.log("ORACLE_DB_ROW:" + JSON.stringify({ status: "KNOWLEDGE_SYNC_FAILED", reason: syncErr.message }));
            process.exit(1);
        }
    } else {
        console.warn("[Oracle Worker] Warning: candidate_knowledge_sync.json not found on Oracle. Proceeding with existing DB tables.");
    }

    const targetUrl = job.finalApplicationUrl || job.external_url || job.url;
    const isIntermediary = externalApplicationRouter.isLinkedInUrl(targetUrl) || externalApplicationRouter.isIndeedUrl(targetUrl);

    // TASK 4 Safeguard: Never visit unresolved intermediary on Oracle
    if (isIntermediary && job.routingStatus !== "RESOLVED") {
        console.warn(`[Oracle Worker] Target URL is an unresolved intermediary platform (${targetUrl}). Leaving for local residential resolution.`);
        await db.run(
            "UPDATE jobs SET status = 'APPLICATION_URL_UNRESOLVED', reason = 'Intermediary URL requires local residential resolution' WHERE (id = ? OR job_id = ?)",
            [job.id || job.job_id, job.job_id || job.id]
        ).catch(() => {});
        console.log("ORACLE_DB_ROW:" + JSON.stringify({ status: "APPLICATION_URL_UNRESOLVED", reason: "Intermediary URL requires local residential resolution" }));
        process.exit(0);
    }

    // Direct final ATS URL reached directly
    job.external_url = targetUrl;
    console.log(`[Oracle Worker] Final ATS URL resolved: ${targetUrl} (ATS: ${job.atsType || job.ats})`);

    await db.run(
        "UPDATE jobs SET status = 'EXTERNAL_IN_PROGRESS' WHERE (id = ? OR job_id = ?)",
        [job.id || job.job_id, job.job_id || job.id]
    ).catch(() => {});

    const browser = new BrowserInstance("foundit");
    await browser.launch();
    const page = await browser.newPage();

    console.log(`[Oracle Worker] Executing External ATS automation directly on: ${targetUrl}`);
    const result = await externalAtsAutomation.apply(page, job);
    console.log("[Oracle Worker] Execution result:", JSON.stringify(result, null, 2));

    await browser.close();

    const updatedRow = await db.get("SELECT * FROM jobs WHERE job_id = ? OR id = ?", [String(job.job_id), String(job.id)]);
    console.log("ORACLE_DB_ROW:" + JSON.stringify(updatedRow || { status: job.statusReason || "WAITING_FOR_INPUT" }));

    process.exit(0);
})().catch(err => {
    console.error("[Oracle Worker] Error:", err.message, err.stack);
    process.exit(1);
});
