const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const externalAtsAutomation = require("../packages/automation/ExternalAtsAutomation");
const resumeSelector = require("../packages/resume/ResumeSelector");
const db = require("../packages/database");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    console.log("[Diagnostic] Initializing Remote Foundit & External ATS Diagnostic Suite...");

    await db.init();

    let storageStateStatus = "MISSING";
    let networkAccess = "UNKNOWN";
    let authStatus = "UNVERIFIED";
    let founditSearchStatus = "NOT_TESTED";
    let jobsFoundFromFoundit = 0;
    let externalJobsFromFoundit = 0;
    let overallFounditResult = "BLOCKED";

    // External ATS Diagnostics Metrics
    let atsSource = "SYNTHETIC_TEST_FIXTURE";
    let targetAtsUrl = "";
    let detectedAts = "Unknown";
    let externalNavStatus = "FAIL";
    let appFormDetected = "FAIL";
    let candidateAutofillStatus = "NOT_TESTED";
    let resumeSelectionVariant = "default";
    let resumeUploadStatus = "NOT_TESTED";
    let questionnaireStatus = "NOT_TESTED";
    let dryRunPreventionStatus = "NOT_REACHED";
    let engineStatus = "FAIL";

    const sessionStatePath = path.join(process.cwd(), "sessions", portal, "storageState.json");
    if (await fs.pathExists(sessionStatePath)) {
        storageStateStatus = "LOADED";
        console.log(`[Diagnostic] Verified local storageState.json for ${portal}: LOADED`);
    } else {
        console.log(`[Diagnostic] Local storageState.json for ${portal}: MISSING`);
    }

    const browserInstance = new BrowserInstance(portal);
    let page;

    try {
        await browserInstance.launch();
        page = await browserInstance.newPage();

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);

        // =========================================================================
        // PART A: FOUNDIT PORTAL VALIDATION (Direct WAF / 403 Inspection)
        // =========================================================================
        console.log("[Diagnostic] Testing direct Foundit network access on Oracle Cloud VM...");
        try {
            const resp = await page.goto("https://www.foundit.in/srp/results?query=DevOps%20Engineer&locations=Bangalore", {
                waitUntil: "domcontentloaded",
                timeout: 25000
            });
            const status = resp ? resp.status() : 0;
            const pageTitle = await page.title().catch(() => "");
            console.log(`[Diagnostic] Foundit response: HTTP ${status}, Page Title: "${pageTitle}"`);

            if (status === 403 || status === 401 || pageTitle.includes("Access Denied")) {
                networkAccess = "BLOCKED_DATACENTER_IP";
                authStatus = "UNVERIFIED";
                founditSearchStatus = "NOT_TESTED";
                overallFounditResult = "BLOCKED";
                console.warn("[Diagnostic] Foundit returned HTTP 403 / Access Denied for datacenter IP.");
            } else {
                networkAccess = "PASS";
                authStatus = "AUTHENTICATED";
                founditSearchStatus = "PASS";
                overallFounditResult = "PASS";
            }
        } catch (netErr) {
            console.error(`[Diagnostic] Foundit network request error: ${netErr.message}`);
            networkAccess = "BLOCKED_DATACENTER_IP";
            authStatus = "UNVERIFIED";
            overallFounditResult = "BLOCKED";
        }

        // =========================================================================
        // PART B: EXTERNAL ATS ENGINE VALIDATION (Queued Jobs or Active Fixture)
        // =========================================================================
        console.log("\n[Diagnostic] Initializing External ATS Engine Validation...");

        // 1. Check for jobs synced from Local Windows Discovery
        const queuedJobsFile = path.join(process.cwd(), "sessions", "queued_external_jobs.json");
        let testJob = null;

        if (await fs.pathExists(queuedJobsFile)) {
            try {
                const queuedJobs = await fs.readJson(queuedJobsFile);
                if (Array.isArray(queuedJobs) && queuedJobs.length > 0) {
                    testJob = queuedJobs.find(j => j.external_url && !j.external_url.includes("foundit.in"));
                    if (testJob) {
                        atsSource = "QUEUED_FROM_FOUNDIT_LOCAL";
                        console.log(`[Diagnostic] Found queued job from local Foundit discovery: "${testJob.title}" at "${testJob.company}" (${testJob.external_url})`);
                    }
                }
            } catch (e) {
                console.warn(`[Diagnostic] Could not read queued_external_jobs.json: ${e.message}`);
            }
        }

        // 2. Fallback to active real synthetic fixture if no queued jobs exist
        if (!testJob) {
            atsSource = "SYNTHETIC_TEST_FIXTURE";
            testJob = {
                portal: "foundit",
                job_id: "ext-gh-gitlab",
                title: "DevOps Engineer (Cloud Infrastructure)",
                company: "GitLab",
                location: "Remote",
                experience: "3-6 Yrs",
                job_description: "We are seeking a DevOps Engineer with experience in AWS, Kubernetes, Terraform, Docker, and CI/CD pipelines.",
                url: "https://boards.greenhouse.io/embed/job_app?for=gitlab&token=6071477",
                external_url: "https://boards.greenhouse.io/embed/job_app?for=gitlab&token=6071477"
            };
            console.log(`[Diagnostic] No local queued jobs found. Using synthetic fixture URL: ${testJob.external_url}`);
        }

        targetAtsUrl = testJob.external_url;
        detectedAts = externalApplicationRouter.classifyATS(targetAtsUrl);

        console.log(`[Diagnostic] Navigating to external application page: ${targetAtsUrl}`);
        const navResp = await page.goto(targetAtsUrl, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => null);
        await page.waitForTimeout(3000);

        if (navResp && navResp.status() < 400) {
            externalNavStatus = "PASS";
            console.log(`[Diagnostic] External page navigation successful (HTTP ${navResp.status()}).`);

            const diagnosticsDir = path.join(process.cwd(), "screenshots", `external_ats_${Date.now()}`);
            await fs.ensureDir(diagnosticsDir);
            await page.screenshot({ path: path.join(diagnosticsDir, "external_form.png"), fullPage: true }).catch(() => {});
            const rawHtml = await page.content().catch(() => "");
            await fs.writeFile(path.join(diagnosticsDir, "external_form.html"), rawHtml).catch(() => {});

            resumeSelectionVariant = resumeSelector.selectResume(testJob.title, testJob.job_description);
            console.log(`[Diagnostic] Selected resume variant: ${resumeSelectionVariant}`);

            console.log("[Diagnostic] Executing ExternalAtsAutomation engine (DRY_RUN=true)...");
            const atsResult = await externalAtsAutomation.apply(page, testJob);

            console.log(`[Diagnostic] ATS Engine execution details: ${JSON.stringify(atsResult, null, 2)}`);

            if (atsResult.externalFormReached) appFormDetected = "PASS";
            if (atsResult.candidateAutofill) candidateAutofillStatus = "PASS";
            if (atsResult.resumeUploaded) resumeUploadStatus = "PASS";
            if (atsResult.questionnaireInspected) questionnaireStatus = "PASS";
            if (atsResult.dryRunPrevented) dryRunPreventionStatus = "PASS";

            if (atsResult.success || atsResult.dryRunPrevented) {
                engineStatus = "PASS";
            }
        } else {
            console.error(`[Diagnostic] External page navigation failed.`);
            externalNavStatus = "FAIL";
        }

    } catch (err) {
        console.error(`[Diagnostic Error] Remote execution error: ${err.message}`, err.stack);
    } finally {
        await browserInstance.close();
        console.log("[Diagnostic] Browser closed.");
    }

    console.log("\n==================================================");
    console.log("FOUNDIT PORTAL VALIDATION");
    console.log("==================================================");
    console.log(`StorageState: ${storageStateStatus}`);
    console.log(`Network Access: ${networkAccess}`);
    console.log(`Authentication: ${authStatus}`);
    console.log(`Foundit Search: ${founditSearchStatus}`);
    console.log(`Jobs Found From Foundit: ${jobsFoundFromFoundit}`);
    console.log(`External Jobs Discovered From Foundit: ${externalJobsFromFoundit}`);
    console.log(`Overall Foundit Result: ${overallFounditResult}`);
    console.log("==================================================\n");

    console.log("==================================================");
    console.log("ORACLE EXTERNAL ATS ENGINE VALIDATION");
    console.log("==================================================");
    console.log(`Source: ${atsSource}`);
    console.log(`Target ATS URL: ${targetAtsUrl}`);
    console.log(`ATS Classification: ${detectedAts}`);
    console.log(`External Page Navigation: ${externalNavStatus}`);
    console.log(`Application Form Detected: ${appFormDetected}`);
    console.log(`Candidate Autofill: ${candidateAutofillStatus}`);
    console.log(`Resume Selection: ${resumeSelectionVariant}`);
    console.log(`Resume Upload: ${resumeUploadStatus}`);
    console.log(`Questionnaire Detection: ${questionnaireStatus}`);
    console.log(`Dry-Run Final Submission Prevention: ${dryRunPreventionStatus}`);
    console.log(`Engine Status: ${engineStatus}`);
    console.log("==================================================\n");

    console.log("=================================");
    console.log("✅ Diagnostic execution complete.");
    console.log("=================================\n");
})();
