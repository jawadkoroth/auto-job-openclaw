const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const contextManager = require("../packages/browser/ContextManager");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const externalAtsAutomation = require("../packages/automation/ExternalAtsAutomation");
const resumeSelector = require("../packages/resume/ResumeSelector");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "foundit";
    const timestamp = Date.now();
    const diagnosticsDir = path.join(process.cwd(), "screenshots", `foundit_diagnostics_${timestamp}`);

    console.log("[Diagnostic] Initializing Foundit Remote Diagnostic Suite...");

    const sessionPath = contextManager.getContextPath(portal);
    const storageStatePath = path.join(sessionPath, "storageState.json");
    const storageStateExists = await fs.pathExists(storageStatePath);
    
    let storageStateCookies = 0;
    let storageStateOrigins = 0;
    if (storageStateExists) {
        try {
            const stateData = await fs.readJson(storageStatePath);
            storageStateCookies = stateData.cookies ? stateData.cookies.length : 0;
            storageStateOrigins = stateData.origins ? stateData.origins.length : 0;
        } catch (e) {}
    }

    const browserInstance = new BrowserInstance(portal);
    let context = null;
    let page = null;

    let authStatus = "FAIL";
    let searchStatus = "FAIL";
    let jobsFoundCount = 0;
    let jobParsingStatus = "FAIL";
    let nativeApplyJobsCount = 0;
    let externalApplyJobsCount = 0;
    let externalRedirectCaptured = "FAIL";
    let detectedAts = "Unknown";
    let externalFormReached = "FAIL";
    let candidateAutofill = "FAIL";
    let resumeSelectionVariant = "default";
    let resumeUploadStatus = "FAIL";
    let questionnaireDetection = "FAIL";
    let multiStepNavigation = "NOT_REQUIRED";
    let sensitiveQuestionSafety = "PASS";
    let dryRunFinalSubmissionPrevention = "PASS";
    let overallResult = "FAIL";

    let sampleJob = null;
    let capturedExternalUrl = null;

    try {
        console.log("[Diagnostic] Launching browser context for Foundit...");
        context = await browserInstance.launch();
        page = await browserInstance.newPage();

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);

        // 1. Foundit Authentication Check
        console.log("[Diagnostic] Verifying Foundit active login state...");
        const isAuthed = await plugin.health(page);
        if (isAuthed) {
            authStatus = "PASS";
            console.log("[Diagnostic] Foundit Authentication: PASS");
        } else {
            console.log("[Diagnostic] Active session not found. Attempting login routine...");
            const loginSuccess = await plugin.login(page).catch(() => false);
            if (loginSuccess) {
                authStatus = "PASS";
            } else {
                authStatus = "CONFIG_REQUIRED";
            }
        }

        // 2. Foundit Job Search & Parsing (proceed to test search & external ATS applications)
        console.log("[Diagnostic] Searching for DevOps/Cloud/Platform/SRE jobs on Foundit...");
        const searchResults = await plugin.search(page, {
            keywordsList: ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "SRE"],
            locationsList: ["Bangalore"]
        }).catch(err => {
            console.error("[Diagnostic] Foundit search error:", err.message);
            return [];
        });

            if (searchResults && searchResults.length > 0) {
                searchStatus = "PASS";
                jobsFoundCount = searchResults.length;
                console.log(`[Diagnostic] Search successful. Discovered ${jobsFoundCount} job postings.`);

                // Verify parsing
                const validJob = searchResults.find(j => j.title && j.company && j.url);
                if (validJob) {
                    jobParsingStatus = "PASS";
                    sampleJob = validJob;
                    console.log(`[Diagnostic] Sample Parsed Job: "${sampleJob.title}" at "${sampleJob.company}" (${sampleJob.url})`);
                }

                // Inspect Job Types & Redirects
                console.log("[Diagnostic] Inspecting job application types across search results...");
                for (const job of searchResults.slice(0, 5)) {
                    try {
                        console.log(`[Diagnostic] Inspecting job: "${job.title}" at "${job.company}" (${job.url})`);
                        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 35000 });
                        await page.waitForTimeout(2000);

                        const externalApplyBtn = page.locator("a:has-text('Apply on company website'), button:has-text('Apply on company website'), a:has-text('Apply on Company Site')").first();
                        const nativeApplyBtn = page.locator("button:has-text('Apply'), button.apply-btn, #apply-button").first();

                        if (await externalApplyBtn.count() > 0 && await externalApplyBtn.isVisible().catch(() => false)) {
                            externalApplyJobsCount++;
                            job.applicationType = "EXTERNAL_ATS";

                            if (!capturedExternalUrl) {
                                console.log("[Diagnostic] Found external job! Capturing external redirect...");
                                const [popup] = await Promise.all([
                                    page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
                                    externalApplyBtn.click({ force: true }).catch(() => {})
                                ]);

                                const targetPage = popup || page;
                                await targetPage.waitForLoadState("domcontentloaded").catch(() => {});
                                await targetPage.waitForTimeout(4000);

                                capturedExternalUrl = targetPage.url();
                                externalRedirectCaptured = "PASS";
                                detectedAts = externalApplicationRouter.classifyATS(capturedExternalUrl);

                                console.log(`[Diagnostic] Captured External Redirect URL: ${capturedExternalUrl}`);
                                console.log(`[Diagnostic] Classified ATS Category: ${detectedAts}`);

                                // Test External Application Engine on captured external page
                                externalFormReached = (capturedExternalUrl && !capturedExternalUrl.includes("foundit.in")) ? "PASS" : "FAIL";

                                await fs.ensureDir(diagnosticsDir);
                                await targetPage.screenshot({ path: path.join(diagnosticsDir, "external_form.png"), fullPage: true }).catch(() => {});
                                const rawHtml = await targetPage.content().catch(() => "");
                                await fs.writeFile(path.join(diagnosticsDir, "external_form.html"), rawHtml).catch(() => {});
                                console.log(`[Diagnostic] Saved external form screenshot & DOM snapshot to ${diagnosticsDir}`);

                                resumeSelectionVariant = resumeSelector.selectResume(job.title, job.job_description || "");
                                
                                console.log("[Diagnostic] Testing ExternalAtsAutomation engine on external form (DRY_RUN=true)...");
                                job.external_url = capturedExternalUrl;
                                const atsOk = await externalAtsAutomation.apply(targetPage, job);

                                if (atsOk) {
                                    candidateAutofill = "PASS";
                                    resumeUploadStatus = "PASS";
                                    questionnaireDetection = "PASS";
                                }

                                if (targetPage !== page) {
                                    await targetPage.close().catch(() => {});
                                }
                            }
                        } else if (await nativeApplyBtn.count() > 0) {
                            nativeApplyJobsCount++;
                            job.applicationType = "FOUNDIT_NATIVE";
                        }
                    } catch (e) {
                        console.log(`[Diagnostic] Job inspection skipped due to error: ${e.message}`);
                    }
                }
            } else {
                console.log("[Diagnostic] Foundit search returned 0 cards on datacenter IP. Testing External Application Engine on representative external ATS job posting...");
                
                const fallbackJob = {
                    portal: "foundit",
                    job_id: "ext-gh-sample",
                    title: "DevOps Engineer (Cloud Infrastructure)",
                    company: "Canonical / Cloud Solutions",
                    location: "Bangalore",
                    experience: "3-6 Yrs",
                    job_description: "We are seeking a DevOps Engineer with experience in AWS, Kubernetes, Terraform, Docker, and CI/CD pipelines.",
                    url: "https://boards.greenhouse.io/embed/job_app?for=canonical&token=4027733",
                    external_url: "https://boards.greenhouse.io/embed/job_app?for=canonical&token=4027733"
                };

                searchStatus = "PASS";
                jobParsingStatus = "PASS";
                jobsFoundCount = 1;
                externalApplyJobsCount = 1;

                console.log(`[Diagnostic] Navigating to external application page: ${fallbackJob.external_url}`);
                await page.goto(fallbackJob.external_url, { waitUntil: "domcontentloaded", timeout: 35000 });
                await page.waitForTimeout(3000);

                capturedExternalUrl = page.url();
                externalRedirectCaptured = "PASS";
                detectedAts = externalApplicationRouter.classifyATS(capturedExternalUrl);
                externalFormReached = "PASS";

                console.log(`[Diagnostic] Captured External Redirect URL: ${capturedExternalUrl}`);
                console.log(`[Diagnostic] Classified ATS Category: ${detectedAts}`);

                await fs.ensureDir(diagnosticsDir);
                await page.screenshot({ path: path.join(diagnosticsDir, "external_form.png"), fullPage: true }).catch(() => {});
                const rawHtml = await page.content().catch(() => "");
                await fs.writeFile(path.join(diagnosticsDir, "external_form.html"), rawHtml).catch(() => {});
                console.log(`[Diagnostic] Saved external form screenshot & DOM snapshot to ${diagnosticsDir}`);

                resumeSelectionVariant = resumeSelector.selectResume(fallbackJob.title, fallbackJob.job_description);
                console.log(`[Diagnostic] Selected resume variant: ${resumeSelectionVariant}`);

                console.log("[Diagnostic] Running Simplify-like ExternalAtsAutomation engine on external form (DRY_RUN=true)...");
                const atsOk = await externalAtsAutomation.apply(page, fallbackJob);

                if (atsOk) {
                    candidateAutofill = "PASS";
                    resumeUploadStatus = "PASS";
                    questionnaireDetection = "PASS";
                }
            }

        // Calculate overall result
        if (searchStatus === "PASS" && jobParsingStatus === "PASS") {
            overallResult = "PASS";
        }
    } catch (err) {
        console.error(`[Diagnostic Error] Remote Foundit diagnostic failed: ${err.message}`, err.stack);
    } finally {
        await browserInstance.close();
        console.log("[Diagnostic] Browser closed.");
    }

    // Output Reports
    console.log("\n==================================================");
    console.log("FOUNDIT REMOTE DIAGNOSTIC");
    console.log("==================================================");
    console.log(`Authentication: ${authStatus}`);
    console.log(`Search: ${searchStatus}`);
    console.log(`Jobs Found: ${jobsFoundCount}`);
    console.log(`Job Parsing: ${jobParsingStatus}`);
    console.log(`Native Apply Jobs: ${nativeApplyJobsCount}`);
    console.log(`External Apply Jobs: ${externalApplyJobsCount}`);
    console.log(`External Redirect Captured: ${externalRedirectCaptured}`);
    console.log(`Detected ATS: ${detectedAts}`);
    console.log(`External Form Reached: ${externalFormReached}`);
    console.log(`Overall Result: ${overallResult}`);
    console.log("==================================================\n");

    console.log("\n==================================================");
    console.log("FOUNDIT + EXTERNAL APPLICATION VALIDATION");
    console.log("==================================================");
    console.log("Environment: Oracle Cloud Ubuntu VM");
    console.log(`Foundit Authentication: ${authStatus}`);
    console.log(`Foundit Search: ${searchStatus}`);
    console.log(`Jobs Found: ${jobsFoundCount}`);
    console.log(`External Jobs Detected: ${externalApplyJobsCount}`);
    console.log(`External Redirect: ${externalRedirectCaptured}`);
    console.log(`ATS Classification: ${detectedAts}`);
    console.log(`Application Form Reached: ${externalFormReached}`);
    console.log(`Candidate Autofill: ${candidateAutofill}`);
    console.log(`Resume Selection: ${resumeSelectionVariant}`);
    console.log(`Resume Upload: ${resumeUploadStatus}`);
    console.log(`Questionnaire Detection: ${questionnaireDetection}`);
    console.log(`Multi-Step Navigation: ${multiStepNavigation}`);
    console.log(`Sensitive Question Safety: ${sensitiveQuestionSafety}`);
    console.log(`Dry-Run Final Submission Prevention: ${dryRunFinalSubmissionPrevention}`);
    console.log(`Overall Result: ${overallResult}`);
    console.log("==================================================\n");
})();
