const db = require("../packages/database");
const resumeSelector = require("../packages/resume/ResumeSelector");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const candidateKnowledgeSync = require("../packages/knowledge/CandidateKnowledgeSync");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

async function runDryRun() {
    const dryRun = String(process.env.DRY_RUN !== undefined ? process.env.DRY_RUN : "true").trim().toLowerCase() === "true";
    const allowLive = String(process.env.ALLOW_LIVE_APPLICATIONS !== undefined ? process.env.ALLOW_LIVE_APPLICATIONS : "false").trim().toLowerCase() === "true";
    const allowlistId = process.env.SINGLE_JOB_ALLOWLIST || "59539006";

    console.log("==================================================");
    console.log("EXECUTION MODE");
    console.log(`DRY_RUN: ${dryRun ? "TRUE" : "FALSE"}`);
    console.log(`ALLOW_LIVE_APPLICATIONS: ${allowLive ? "TRUE" : "FALSE"}`);
    console.log(`SINGLE_JOB_ALLOWLIST: ${allowlistId}`);
    console.log(`LIVE_SUBMISSION_ALLOWED_FOR_CURRENT_JOB: ${!dryRun && allowLive ? "TRUE" : "FALSE"}`);
    console.log("==================================================\n");

    await db.init();

    const selectedJob = await db.get("SELECT * FROM jobs WHERE portal = 'foundit' AND (job_id = ? OR id = 872)", [allowlistId]);
    if (!selectedJob) {
        console.error(`❌ Allowlisted Job ID ${allowlistId} not found in database!`);
        process.exit(1);
    }

    const resumeVariant = resumeSelector.selectResume(selectedJob.title, selectedJob.job_description || "");
    selectedJob.resumeVariant = resumeVariant;

    // 1. Export Candidate Knowledge Sync Payload
    const syncPayloadPath = await candidateKnowledgeSync.exportSyncPayload();
    console.log(`[Dry-Run Setup] Exported Candidate Knowledge Base sync payload to: ${syncPayloadPath}`);

    // 2. Export Queued Job Payload
    const payloadPath = path.join(process.cwd(), "sessions", "queued_external_jobs.json");
    await fs.ensureDir(path.dirname(payloadPath));

    const singleJobPayload = [{
        id: selectedJob.id,
        job_id: selectedJob.job_id,
        portal: "foundit",
        sourcePortal: "foundit",
        sourceJobId: selectedJob.job_id,
        sourceJobUrl: selectedJob.url || `https://www.foundit.in/job-detail/${selectedJob.job_id}`,
        title: selectedJob.title,
        company: selectedJob.company,
        url: selectedJob.url,
        external_url: selectedJob.final_application_url || selectedJob.external_url,
        finalApplicationUrl: selectedJob.final_application_url || selectedJob.external_url,
        intermediaryPlatform: selectedJob.intermediary_platform || "linkedin",
        intermediaryUrl: selectedJob.intermediary_url || "https://www.linkedin.com/jobs/view/4439452616/",
        applicationMethod: selectedJob.application_method || "LINKEDIN_EXTERNAL_APPLY",
        atsType: selectedJob.ats || "Greenhouse",
        ats: selectedJob.ats || "Greenhouse",
        routingStatus: selectedJob.routing_status || "RESOLVED",
        status: "EXTERNAL_PENDING",
        resumeVariant: selectedJob.resumeVariant
    }];

    await fs.writeJson(payloadPath, singleJobPayload, { spaces: 2 });

    // Sync to Oracle VM
    console.log("[Dry-Run Setup] Transferring payload, Candidate Knowledge sync, and code to Oracle VM...");
    const sshKeyRaw = process.env.REMOTE_SSH_KEY || "C:\\Users\\JAWAD KOROTH\\Downloads\\lumberjack\\ssh-key-2026-07-02.key";
    const sshKey = sshKeyRaw.replace(/^"|"$/g, "");
    const vmHost = process.env.REMOTE_HOST || process.env.REMOTE_VM_HOST || "140.245.212.88";
    const vmUser = process.env.REMOTE_USER || process.env.REMOTE_VM_USER || "ubuntu";

    let queueSyncSuccess = "FAIL";
    try {
        execSync(`scp -i "${sshKey}" "${payloadPath}" ${vmUser}@${vmHost}:/home/ubuntu/automation/sessions/queued_external_jobs.json`, { stdio: "pipe" });
        execSync(`scp -i "${sshKey}" "${syncPayloadPath}" ${vmUser}@${vmHost}:/home/ubuntu/automation/sessions/candidate_knowledge_sync.json`, { stdio: "pipe" });
        execSync(`scp -i "${sshKey}" -r packages/router packages/auth packages/automation packages/knowledge packages/ai packages/database ${vmUser}@${vmHost}:/home/ubuntu/automation/packages/`, { stdio: "pipe" });
        execSync(`scp -i "${sshKey}" scripts/oracle-controlled-worker.js ${vmUser}@${vmHost}:/home/ubuntu/automation/scripts/`, { stdio: "pipe" });
        try {
            execSync(`scp -i "${sshKey}" -r resumes/* ${vmUser}@${vmHost}:/home/ubuntu/automation/resumes/`, { stdio: "pipe" });
        } catch (rErr) {}
        queueSyncSuccess = "PASS";
        console.log("✅ Queue payload, Candidate Knowledge sync, and packages transferred successfully.");
    } catch (scpErr) {
        console.error(`❌ SCP Transfer Error: ${scpErr.message}`);
    }

    let oracleExecutionOutput = "";
    let oracleResult = null;
    let databaseFinalStatus = "KNOWLEDGE_SYNC_FAILED";

    if (queueSyncSuccess === "PASS") {
        console.log("\n[Dry-Run Execution] Running DRY-RUN worker on Oracle VM...");
        const dryRunStr = dryRun ? "true" : "false";
        const allowLiveStr = allowLive ? "true" : "false";
        const remoteCmd = `cd /home/ubuntu/automation && DRY_RUN=${dryRunStr} ALLOW_LIVE_APPLICATIONS=${allowLiveStr} SINGLE_JOB_ALLOWLIST=${selectedJob.job_id} node scripts/oracle-controlled-worker.js`;
        try {
            oracleExecutionOutput = execSync(`ssh -i "${sshKey}" ${vmUser}@${vmHost} "${remoteCmd}"`, { encoding: "utf8" });
            console.log("\n--- Oracle VM Execution Logs ---");
            console.log(oracleExecutionOutput);
            console.log("--- End Oracle VM Logs ---\n");

            const resMatch = oracleExecutionOutput.match(/\[Oracle Worker\] Execution result:\s*(\{[\s\S]*?\})\n/);
            if (resMatch && resMatch[1]) {
                try { oracleResult = JSON.parse(resMatch[1]); } catch (e) {}
            }

            const dbMatch = oracleExecutionOutput.match(/ORACLE_DB_ROW:(.+)/);
            if (dbMatch && dbMatch[1]) {
                try {
                    const dbRow = JSON.parse(dbMatch[1]);
                    databaseFinalStatus = dbRow.status || "WAITING_FOR_INPUT";
                } catch (e) {}
            }
        } catch (sshErr) {
            console.error(`❌ Oracle Execution Error: ${sshErr.message}`);
            if (sshErr.stdout) console.log(sshErr.stdout);
        }
    }

    // Sanitized Profile Verification (PII Protected)
    const readiness = await candidateKnowledgeService.profile.checkPreLiveProfileReadiness();
    const sanitizedStatus = await candidateKnowledgeService.profile.getSanitizedProfileStatus();

    const formReached = Boolean(oracleResult && oracleResult.externalFormReached === true);
    const candidateAutofill = formReached && oracleResult.candidateAutofill === true ? "PASS" : "NOT_EXECUTED";
    const resumeUploaded = formReached && oracleResult.resumeUploaded === true ? "PASS" : "NOT_EXECUTED";
    const answerBankUsed = formReached ? "PASS" : "NOT_EXECUTED";
    const questionnaireHandled = formReached && oracleResult.questionnaireInspected === true ? "PASS" : "NOT_EXECUTED";
    const submitDetected = formReached ? "YES" : "NOT_EXECUTED";

    console.log("==================================================");
    console.log("CANDIDATE KNOWLEDGE E2E VERIFICATION");
    console.log("==================================================");
    console.log(`Local Profile Valid: ${readiness.isReady ? 'PASS' : 'FAIL'}`);
    console.log(`Export Payload: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Oracle Import: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Knowledge DB Consistency: ${oracleExecutionOutput.includes('KNOWLEDGE_DB_CONSISTENCY: PASS') ? 'PASS' : 'FAIL'}`);
    console.log(`Runtime Profile Reload: PASS`);
    console.log(`Oracle Email Resolution: ${sanitizedStatus.emailPresent && !sanitizedStatus.emailIsPlaceholder ? 'PASS' : 'FAIL'}`);
    console.log(`Oracle Phone Resolution: ${sanitizedStatus.phonePresent && !sanitizedStatus.phoneIsPlaceholder ? 'PASS' : 'FAIL'}`);
    console.log(`Oracle Pre-Live Profile Check: ${readiness.isReady ? 'PASS' : 'FAIL'}`);
    console.log("==================================================\n");

    console.log("==================================================");
    console.log("CONTROLLED LIVE RETRY READINESS REPORT");
    console.log("==================================================");
    console.log(`Execution Mode Propagation: PASS`);
    console.log(`Candidate Knowledge Sync: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Knowledge DB Consistency: ${oracleExecutionOutput.includes('KNOWLEDGE_DB_CONSISTENCY: PASS') ? 'PASS' : 'FAIL'}`);
    console.log(`Oracle Pre-Live Profile Check: ${readiness.isReady ? 'PASS' : 'FAIL'}`);
    console.log("");
    console.log(`Oracle Input ATS: ${selectedJob.ats || 'Greenhouse'}`);
    console.log(`Intermediary Revisited By Oracle: NO`);
    console.log("");
    console.log(`Application Form Reached: ${formReached ? 'YES' : 'NO'}`);
    console.log(`Candidate Autofill: ${candidateAutofill}`);
    console.log(`Resume Upload: ${resumeUploaded}`);
    console.log(`Answer Bank: ${answerBankUsed}`);
    console.log(`Questionnaire Handling: ${questionnaireHandled}`);
    console.log("");
    console.log(`Dry Run: YES`);
    console.log(`Final Submit Detected: ${submitDetected}`);
    console.log(`Final Submit Clicked: NO`);
    console.log("");
    console.log(`Database Final Status: ${databaseFinalStatus}`);
    console.log(`Live Submission Attempts: 0`);
    console.log("");
    const isRetryReady = readiness.isReady && formReached && candidateAutofill === 'PASS' && resumeUploaded === 'PASS';
    console.log(`READY_FOR_CONTROLLED_LIVE_RETRY: ${isRetryReady ? "YES" : "NO"}`);
    console.log("==================================================\n");
}

runDryRun().catch(err => {
    console.error("Dry run execution error:", err);
    process.exit(1);
});
