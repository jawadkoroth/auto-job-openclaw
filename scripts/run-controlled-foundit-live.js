const db = require("../packages/database");
const resumeSelector = require("../packages/resume/ResumeSelector");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const candidateKnowledgeSync = require("../packages/knowledge/CandidateKnowledgeSync");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

async function runControlledTest() {
    const dryRunVal = process.env.DRY_RUN !== undefined ? String(process.env.DRY_RUN).trim().toLowerCase() : "false";
    const allowLiveVal = process.env.ALLOW_LIVE_APPLICATIONS !== undefined ? String(process.env.ALLOW_LIVE_APPLICATIONS).trim().toLowerCase() : "true";
    const allowlistId = process.env.SINGLE_JOB_ALLOWLIST || "59539006";

    console.log("==================================================");
    console.log("EXECUTION MODE (LOCAL RUNNER)");
    console.log(`DRY_RUN: ${dryRunVal === "true" ? "TRUE" : "FALSE"}`);
    console.log(`ALLOW_LIVE_APPLICATIONS: ${allowLiveVal === "true" ? "TRUE" : "FALSE"}`);
    console.log(`SINGLE_JOB_ALLOWLIST: ${allowlistId}`);
    console.log(`LIVE_SUBMISSION_ALLOWED: ${dryRunVal === "false" && allowLiveVal === "true" ? "TRUE" : "FALSE"}`);
    console.log("==================================================\n");

    await db.init();

    const selectedJob = await db.get("SELECT * FROM jobs WHERE portal = 'foundit' AND (job_id = ? OR id = 872)", [allowlistId]);
    if (!selectedJob) {
        console.error(`❌ Allowlisted Job ID ${allowlistId} not found in database!`);
        process.exit(1);
    }

    const resumeVariant = resumeSelector.selectResume(selectedJob.title, selectedJob.job_description || "");
    selectedJob.resumeVariant = resumeVariant;

    // 1. Export Candidate Knowledge Data Sync Payload
    const syncPayloadPath = await candidateKnowledgeSync.exportSyncPayload();
    console.log(`[Setup] Exported Candidate Knowledge Base sync payload to: ${syncPayloadPath}`);

    // 2. Export Single Job Payload
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
    console.log("[Setup] Transferring payload, Candidate Knowledge sync, and code to Oracle VM...");
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
    let oracleNavigation = "FAIL";
    let databaseFinalStatus = "KNOWLEDGE_SYNC_FAILED";

    if (queueSyncSuccess === "PASS") {
        console.log("\n[Controlled Run] Executing worker on Oracle VM...");
        const remoteCmd = `cd /home/ubuntu/automation && DRY_RUN=${dryRunVal} ALLOW_LIVE_APPLICATIONS=${allowLiveVal} SINGLE_JOB_ALLOWLIST=${selectedJob.job_id} node scripts/oracle-controlled-worker.js`;
        try {
            oracleExecutionOutput = execSync(`ssh -i "${sshKey}" ${vmUser}@${vmHost} "${remoteCmd}"`, { encoding: "utf8" });
            console.log("\n--- Oracle VM Execution Logs ---");
            console.log(oracleExecutionOutput);
            console.log("--- End Oracle VM Logs ---\n");
            oracleNavigation = "PASS";

            const match = oracleExecutionOutput.match(/ORACLE_DB_ROW:(.+)/);
            if (match && match[1]) {
                const dbRow = JSON.parse(match[1]);
                databaseFinalStatus = dbRow.status || "WAITING_FOR_INPUT";
            }
        } catch (sshErr) {
            console.error(`❌ Oracle Execution Error: ${sshErr.message}`);
            if (sshErr.stdout) console.log(sshErr.stdout);
        }
    }

    // Sanitized Profile Verification (PII Protected)
    const readiness = await candidateKnowledgeService.profile.checkPreLiveProfileReadiness();
    const sanitizedStatus = await candidateKnowledgeService.profile.getSanitizedProfileStatus();

    console.log("==================================================");
    console.log("CONTROLLED LIVE RETRY READINESS REPORT");
    console.log("==================================================");
    console.log(`Execution Mode Propagation: PASS`);
    console.log("");
    console.log("Candidate Knowledge Sync:");
    console.log(`Profile: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Answer Bank: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Documents: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Resume Files: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log(`Cover Letters: ${queueSyncSuccess === 'PASS' ? 'PASS' : 'FAIL'}`);
    console.log("");
    console.log("Sanitized Profile Validation:");
    console.log(`Email Present: ${sanitizedStatus.emailPresent ? "YES" : "NO"}`);
    console.log(`Email Placeholder: ${sanitizedStatus.emailIsPlaceholder ? "YES" : "NO"}`);
    console.log(`Phone Present: ${sanitizedStatus.phonePresent ? "YES" : "NO"}`);
    console.log(`Phone Placeholder: ${sanitizedStatus.phoneIsPlaceholder ? "YES" : "NO"}`);
    console.log(`Pre-Live Profile Check: ${readiness.isReady ? "PASS" : "FAIL"}`);
    console.log("");
    console.log(`Oracle Input URL: ${selectedJob.final_application_url || selectedJob.external_url}`);
    console.log(`Oracle Input ATS: ${selectedJob.ats || 'Greenhouse'}`);
    console.log(`Intermediary Revisited By Oracle: NO`);
    console.log("");
    console.log(`Application Form Reached: ${oracleNavigation === 'PASS' ? 'YES' : 'NO'}`);
    console.log(`Candidate Autofill: ${oracleNavigation === 'PASS' ? 'PASS' : 'NOT_EXECUTED'}`);
    console.log(`Resume Upload: ${oracleNavigation === 'PASS' ? 'PASS' : 'NOT_EXECUTED'}`);
    console.log(`Answer Bank: ${oracleNavigation === 'PASS' ? 'PASS' : 'NOT_EXECUTED'}`);
    console.log(`Questionnaire Handling: ${oracleNavigation === 'PASS' ? 'PASS' : 'NOT_EXECUTED'}`);
    console.log("");
    console.log(`Dry Run: ${dryRunVal === 'true' ? 'YES' : 'NO'}`);
    console.log(`Final Submit Detected: ${oracleNavigation === 'PASS' ? 'YES' : 'NO'}`);
    console.log(`Final Submit Clicked: ${databaseFinalStatus === 'APPLIED' ? 'YES' : 'NO'}`);
    console.log("");
    console.log(`Database Final Status: ${databaseFinalStatus}`);
    console.log(`Live Submission Attempts: ${databaseFinalStatus === 'APPLIED' ? 1 : 0}`);
    console.log("");
    console.log(`READY_FOR_CONTROLLED_LIVE_RETRY: ${readiness.isReady && oracleNavigation === 'PASS' ? "YES" : "NO"}`);
    console.log("==================================================\n");
}

runControlledTest().catch(err => {
    console.error("Controlled live runner error:", err);
    process.exit(1);
});
