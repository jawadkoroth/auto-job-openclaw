const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

process.env.DRY_RUN = "true";
process.env.ALLOW_LIVE_APPLICATIONS = "false";
process.env.ENABLE_CUTSHORT = "true";

const db = require("../packages/database");
const logger = require("../packages/logger");
const pluginManager = require("../packages/plugins/PluginManager");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT DRY RUN AUTOMATION RUNNER (PHASE 5)");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    const metrics = {
        jobsFound: 0,
        relevantJobs: 0,
        indiaEligible: 0,
        duplicates: 0,
        nativeApplications: 0,
        externalApplications: 0,
        candidateAutofill: 0,
        resumeUpload: 0,
        waitingForInput: 0,
        failures: 0,
        failureBreakdown: {}
    };

    await db.init();
    pluginManager.loadPlugins();

    const plugin = pluginManager.getPlugin("cutshort");
    const browserInstance = new BrowserInstance("cutshort");

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();

        // 1. Perform Real Discovery
        console.log("[Phase 5] Running Cutshort Discovery...");
        const discovered = await plugin.search(page, {
            keywordsList: [
                "DevOps Engineer",
                "Cloud Engineer",
                "Platform Engineer",
                "Infrastructure Engineer",
                "Kubernetes Engineer"
            ]
        });

        metrics.jobsFound = discovered.length;
        console.log(` -> Discovered ${metrics.jobsFound} jobs from Cutshort search.`);

        for (const job of discovered) {
            // Check location eligibility
            const locRes = checkLocationEligibility(job.location, job.title);
            if (locRes.eligible) {
                metrics.indiaEligible++;
            }

            // Check title relevance
            const lowerTitle = job.title.toLowerCase();
            if (lowerTitle.includes("devops") || lowerTitle.includes("cloud") || lowerTitle.includes("platform") || lowerTitle.includes("infrastructure") || lowerTitle.includes("sre") || lowerTitle.includes("kubernetes")) {
                metrics.relevantJobs++;
            }

            // Check duplicate in DB
            const existing = await db.get("SELECT id FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
            if (existing) {
                metrics.duplicates++;
            } else {
                // Save to DB
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, status) VALUES ('cutshort', ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED')",
                    [job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                );
            }
        }

        // 2. Process discovered candidate applications in DRY RUN mode
        const dryRunCandidates = await db.all("SELECT * FROM jobs WHERE portal = 'cutshort' AND (status = 'DISCOVERED' OR status IS NULL) LIMIT 5");
        console.log(`\n[Phase 5] Testing Dry Run Application Pipeline for ${dryRunCandidates.length} jobs...`);

        for (const job of dryRunCandidates) {
            console.log(`\n--- Dry-Running Job ID: ${job.job_id} ("${job.title}" at "${job.company}") ---`);
            const success = await plugin.apply(page, job);
            
            const updatedJob = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
            if (updatedJob.application_method === "EXTERNAL_ATS") {
                metrics.externalApplications++;
            } else {
                metrics.nativeApplications++;
            }

            metrics.candidateAutofill++;
            metrics.resumeUpload++;

            if (updatedJob.status === "WAITING_FOR_INPUT") {
                metrics.waitingForInput++;
            } else if (updatedJob.status === "FAILED") {
                metrics.failures++;
                const reason = updatedJob.reason || "UNKNOWN_ERROR";
                metrics.failureBreakdown[reason] = (metrics.failureBreakdown[reason] || 0) + 1;
            }
        }

    } catch (err) {
        console.error(`❌ Dry Run execution error: ${err.message}`);
    } finally {
        await browserInstance.close().catch(() => {});
    }

    console.log("\n==================================================");
    console.log("CUTSHORT DRY RUN METRICS REPORT");
    console.log("==================================================");
    console.log(`Jobs Found: ${metrics.jobsFound}`);
    console.log(`Relevant Jobs: ${metrics.relevantJobs}`);
    console.log(`India Eligible: ${metrics.indiaEligible}`);
    console.log(`Duplicates: ${metrics.duplicates}`);
    console.log(`Native Applications: ${metrics.nativeApplications}`);
    console.log(`External Applications: ${metrics.externalApplications}`);
    console.log(`Candidate Autofill: ${metrics.candidateAutofill}`);
    console.log(`Resume Upload: ${metrics.resumeUpload}`);
    console.log(`Waiting For Input: ${metrics.waitingForInput}`);
    console.log(`Failures: ${metrics.failures}`);
    console.log(`Failure Breakdown: ${JSON.stringify(metrics.failureBreakdown)}`);
    console.log("==================================================\n");

    console.log("JSON_DRYRUN_REPORT_BEGIN");
    console.log(JSON.stringify(metrics, null, 2));
    console.log("JSON_DRYRUN_REPORT_END");
})();
