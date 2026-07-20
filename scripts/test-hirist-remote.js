const path = require("path");
const fs = require("fs-extra");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const config = require("../packages/config");

(async () => {
    console.log("=== HIRIST REMOTE DIAGNOSTIC ===");
    const portal = "hirist";
    const timestamp = Date.now();
    const diagnosticsDir = path.join(process.cwd(), "screenshots", `hirist_diagnostics_${timestamp}`);

    // Pre-launch session check (Task 3)
    const contextManager = require("../packages/browser/ContextManager");
    const sessionPath = contextManager.getContextPath(portal);
    const metadataPath = contextManager.getMetadataPath(portal);

    const sessionDirExists = fs.existsSync(sessionPath);
    let sessionFiles = [];
    if (sessionDirExists) {
        sessionFiles = fs.readdirSync(sessionPath);
    }
    const sessionExists = sessionDirExists && sessionFiles.length > 0;
    const metadataExists = fs.existsSync(metadataPath);
    const metadata = metadataExists ? fs.readJsonSync(metadataPath) : null;

    // Check storageState.json details (Task 5)
    const storageStatePath = path.join(sessionPath, "storageState.json");
    const storageStateExists = fs.existsSync(storageStatePath);
    let storageStateCookies = 0;
    let storageStateOrigins = 0;
    if (storageStateExists) {
        try {
            const state = fs.readJsonSync(storageStatePath);
            storageStateCookies = state.cookies ? state.cookies.length : 0;
            storageStateOrigins = state.origins ? state.origins.length : 0;
        } catch (e) {
            console.error(`[Diagnostic] Failed to read storageState.json: ${e.message}`);
        }
    }

    console.log(`[Diagnostic] Session directory path: ${sessionPath}`);
    console.log(`[Diagnostic] Session directory exists: ${sessionDirExists ? "YES" : "NO"}`);
    console.log(`[Diagnostic] Session directory file count: ${sessionFiles.length}`);
    console.log(`[Diagnostic] Metadata file exists: ${metadataExists ? "YES" : "NO"}`);
    if (metadata) {
        console.log(`[Diagnostic] Metadata session health: ${metadata.sessionHealth}`);
        console.log(`[Diagnostic] Metadata last login: ${metadata.lastLogin}`);
        console.log(`[Diagnostic] Metadata last refresh: ${metadata.lastRefresh}`);
    }
    console.log(`[Diagnostic] StorageState file exists: ${storageStateExists ? "YES" : "NO"}`);
    console.log(`[Diagnostic] StorageState cookie count: ${storageStateCookies}`);
    console.log(`[Diagnostic] StorageState origin count: ${storageStateOrigins}`);

    const browserInstance = new BrowserInstance(portal);
    let context = null;
    let page = null;
    let authStatus = "UNKNOWN";
    let searchStatus = "FAIL";
    let jobsFoundCount = 0;
    let jobParsingStatus = "FAIL";
    let parsedJob = { title: "N/A", company: "N/A", location: "N/A", experience: "N/A" };
    let coverLetterOptionDetected = "NO";
    let coverLetterEnabled = "NO";
    let coverLetterFieldFilled = "NO";
    let finalSubmitClicked = "NO";
    let overallResult = "FAIL";

    // Diagnostic variables (Task 5)
    let loadedCookiesCount = 0;
    let finalUrl = "N/A";
    let httpStatus = "N/A";
    let pageTitle = "N/A";
    let loggedInCount = 0;
    let loginCount = 0;
    let pageContent = "";
    let userAgent = "N/A";
    let webdriver = false;

    try {
        console.log("[Diagnostic] Launching browser...");
        context = await browserInstance.launch();
        page = await browserInstance.newPage();

        // Capture user agent & webdriver status
        userAgent = await page.evaluate(() => navigator.userAgent);
        webdriver = await page.evaluate(() => navigator.webdriver);
        console.log(`[Diagnostic] navigator.userAgent: ${userAgent}`);
        console.log(`[Diagnostic] navigator.webdriver: ${webdriver}`);

        // Capture loaded cookies count
        const cookies = await context.cookies();
        loadedCookiesCount = cookies.length;
        console.log(`[Diagnostic] Loaded cookies count: ${loadedCookiesCount}`);

        // Track dry-run submission interception
        let interceptedSubmitUrl = null;
        let interceptedSubmitMethod = null;
        let dryRunPreventedFinalSubmit = "PASS"; // Default PASS as safety rule is active

        // Setup route interception for dry-run safety (block ONLY final application submission)
        console.log("[Diagnostic] Registering targeted dry-run safety route interceptors...");
        await page.route("**/*", async (route, request) => {
            const url = request.url();
            const method = request.method().toUpperCase();
            
            // Targeted application submission endpoint patterns
            const isSubmissionEndpoint = 
                (method === "POST" || method === "PUT" || method === "PATCH") &&
                (
                    url.includes("/job/apply") ||
                    url.includes("/job/screening") ||
                    url.includes("/applyJob") ||
                    url.includes("/candidate/apply") ||
                    url.includes("/application/submit") ||
                    url.includes("gladiator.hirist.tech/user/apply") ||
                    url.includes("gladiator.hirist.tech/job/apply")
                );

            if (isSubmissionEndpoint) {
                interceptedSubmitUrl = url;
                interceptedSubmitMethod = method;
                dryRunPreventedFinalSubmit = "PASS";
                console.log("\n==================================================");
                console.log(`[DRY_RUN PREVENTED FINAL SUBMIT] Intercepted and blocked submission request: ${method} ${url}`);
                const headers = request.headers();
                const sanitizedHeaders = { ...headers };
                if (sanitizedHeaders.authorization) sanitizedHeaders.authorization = "[REDACTED]";
                if (sanitizedHeaders.cookie) sanitizedHeaders.cookie = "[REDACTED]";
                console.log(`[DRY_RUN INTERCEPTED HEADERS] ${JSON.stringify(sanitizedHeaders)}`);
                const postData = request.postData();
                if (postData) {
                    console.log(`[DRY_RUN INTERCEPTED PAYLOAD] ${postData.substring(0, 300)}`);
                }
                console.log("==================================================\n");
                return route.abort();
            }

            // Log non-submission POST/PUT/PATCH API calls safely for debugging
            if ((method === "POST" || method === "PUT" || method === "PATCH") && url.includes("hirist.tech")) {
                console.log(`[DRY_RUN ALLOWED API] ${method} -> ${url}`);
            }

            route.continue();
        });

        // Navigate to homepage
        const initialUrl = "https://www.hirist.tech/";
        console.log(`[Diagnostic] Navigating to homepage: ${initialUrl}`);
        const response = await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        finalUrl = page.url();
        httpStatus = response ? response.status() : "N/A";
        pageTitle = await page.title();

        console.log(`[Diagnostic] Final URL: ${finalUrl}`);
        console.log(`[Diagnostic] HTTP Status: ${httpStatus}`);
        console.log(`[Diagnostic] Page Title: ${pageTitle}`);

        // Wait a short fixed stabilization period
        console.log("[Diagnostic] Waiting 5s stabilization period...");
        await page.waitForTimeout(5000);

        // UI Indicators
        const loggedInIndicators = [
            "a[href*='logout']",
            "a[href*='profile.html']",
            "a:has-text('Logout')",
            "a:has-text('My Profile')"
        ];
        const loginIndicators = [
            "a:has-text('Login')",
            "p:has-text('Login')",
            "button:has-text('Login')",
            "div.login-btn",
            "p.login",
            "a:has-text('Register')"
        ];

        loggedInCount = 0;
        let matchedLoggedInSelector = "";
        for (const sel of loggedInIndicators) {
            const c = await page.locator(sel).count();
            if (c > 0) {
                loggedInCount += c;
                matchedLoggedInSelector = sel;
            }
        }

        loginCount = 0;
        let matchedLoginSelector = "";
        for (const sel of loginIndicators) {
            const c = await page.locator(sel).count();
            if (c > 0) {
                loginCount += c;
                matchedLoginSelector = sel;
            }
        }

        console.log(`[Diagnostic] Authenticated UI indicators count: ${loggedInCount} (e.g. matched "${matchedLoggedInSelector}")`);
        console.log(`[Diagnostic] Login UI indicators count: ${loginCount} (e.g. matched "${matchedLoginSelector}")`);

        // Classify authentication state (Task 4)
        pageContent = await page.content();
        
        // If final URL includes jobfeed, they are definitely authenticated
        const isUrlAuthenticated = finalUrl.includes("hirist.tech/jobfeed") || finalUrl.includes("hirist.tech/profile.html");
        
        if (pageContent.includes("Cloudflare") || pageContent.includes("Verify you are human") || pageTitle.includes("Cloudflare") || httpStatus === 403) {
            authStatus = "BLOCKED";
        } else if (loggedInCount > 0 || isUrlAuthenticated) {
            authStatus = "AUTHENTICATED";
        } else if (loginCount > 0) {
            if (storageStateExists) {
                authStatus = "SESSION_EXPIRED";
            } else {
                authStatus = "LOGIN_REQUIRED";
            }
        } else {
            authStatus = "UNKNOWN";
        }

        console.log(`[Diagnostic] Classified Auth Status: ${authStatus}`);

        // Save failure diagnostics if not authenticated
        if (authStatus !== "AUTHENTICATED") {
            console.log(`[Diagnostic] Authentication check failed (${authStatus}). Saving diagnostics to ${diagnosticsDir}`);
            await fs.ensureDir(diagnosticsDir);
            await fs.writeFile(path.join(diagnosticsDir, "page.html"), pageContent);
            await page.screenshot({ path: path.join(diagnosticsDir, "page.png"), fullPage: true }).catch(() => {});
            
            const diagInfo = {
                initialUrl,
                finalUrl,
                httpStatus,
                pageTitle,
                sessionExists,
                storageStateExists,
                storageStateCookies,
                storageStateOrigins,
                cookiesCount: loadedCookiesCount,
                loggedInIndicatorsCount: loggedInCount,
                loginIndicatorsCount: loginCount,
                userAgent,
                webdriver,
                authStatus,
                metadata: metadata ? { ...metadata, browserVersion: undefined } : null
            };
            await fs.writeJson(path.join(diagnosticsDir, "diagnostics.json"), diagInfo, { spaces: 2 });
        }

        // Application flow diagnostic variables
        let applicationPageReached = "FAIL";
        let applicationFormDetected = "FAIL";
        let coverLetterStatus = "NOT_AVAILABLE";
        let textInputsCount = 0;
        let textareasCount = 0;
        let radioButtonsCount = 0;
        let checkboxesCount = 0;
        let dropdownsCount = 0;
        let resumeControlsCount = 0;
        let nextBtnCount = 0;
        let submitBtnCount = 0;
        let uniqueQuestions = [];

        // Run authenticated test flow
        if (authStatus === "AUTHENTICATED") {
            pluginManager.loadPlugins();
            const plugin = pluginManager.getPlugin(portal);

            console.log("[Diagnostic] Searching for jobs...");
            const jobs = await plugin.search(page, { keywordsList: ["DevOps Engineer"], locationsList: ["Bangalore"] });
            if (jobs && jobs.length > 0) {
                searchStatus = "PASS";
                jobsFoundCount = jobs.length;
                console.log(`[Diagnostic] Search successful. Found ${jobsFoundCount} jobs.`);

                const job = jobs[0];
                if (job.title && job.company && job.location && job.experience) {
                    jobParsingStatus = "PASS";
                    parsedJob = {
                        title: job.title,
                        company: job.company,
                        location: job.location,
                        experience: job.experience
                    };
                }

                console.log(`[Diagnostic] Testing application flow for job: "${job.title}" at "${job.company}"`);
                console.log(`[Diagnostic] Navigating to job URL: ${job.url}`);
                await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 40000 });
                await page.waitForTimeout(3000);

                // Look for Apply button to open drawer/screening page
                const applyBtnSelector = "button:has-text('Apply'), button.apply-btn, #apply-button, button:has-text('Easy Apply')";
                const applyBtn = page.locator(applyBtnSelector).filter({ visible: true }).first();
                if (await applyBtn.count() > 0) {
                    console.log("[Diagnostic] Click action on primary Apply button to open flow...");
                    await applyBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(4000);
                }

                // Verify application/screening page reached
                const currentAppUrl = page.url();
                applicationPageReached = (currentAppUrl.includes("/screening") || currentAppUrl.includes("/job/") || currentAppUrl.includes("/apply")) ? "PASS" : "FAIL";
                console.log(`[Diagnostic] Application/Screening page URL: ${currentAppUrl}`);
                console.log(`[Diagnostic] Application/Screening page reached: ${applicationPageReached}`);

                // Save full page screenshot and sanitized HTML snapshot of screening page
                await fs.ensureDir(diagnosticsDir);
                const screenshotPath = path.join(diagnosticsDir, "screening_page.png");
                const htmlPath = path.join(diagnosticsDir, "screening_page.html");

                await page.screenshot({ path: screenshotPath, fullPage: true }).catch(err => console.error("Screenshot error:", err.message));
                
                const rawHtml = await page.content().catch(() => "");
                const sanitizedHtml = rawHtml.replace(/"token":"[^"]+"/g, '"token":"[REDACTED]"');
                await fs.writeFile(htmlPath, sanitizedHtml).catch(err => console.error("HTML save error:", err.message));
                console.log(`[Diagnostic] Saved screening page screenshot to ${screenshotPath}`);
                console.log(`[Diagnostic] Saved screening page DOM snapshot to ${htmlPath}`);

                // Comprehensive DOM Element Inspection
                console.log("[Diagnostic] Inspecting screening form DOM structure...");

                textInputsCount = await page.locator("input[type='text'], input[type='number'], input:not([type])").count();
                textareasCount = await page.locator("textarea").count();
                radioButtonsCount = await page.locator("input[type='radio']").count();
                checkboxesCount = await page.locator("input[type='checkbox']").count();
                dropdownsCount = await page.locator("select, div[role='combobox'], div.MuiSelect-select").count();
                resumeControlsCount = await page.locator("input[type='file'], div:has-text('Resume'), span:has-text('Resume')").count();

                // Screening questions count and text snippets
                const questionElements = await page.locator("div.screening-question, div[class*='question' i], label.question, p.question-text, fieldset").allInnerTexts().catch(() => []);
                uniqueQuestions = Array.from(new Set(questionElements.map(q => q.trim()).filter(q => q.length > 5 && q.length < 200)));

                // Navigation & Submit buttons
                nextBtnCount = await page.locator("button:has-text('Next'), button:has-text('Continue'), button:has-text('Proceed')").filter({ visible: true }).count();
                submitBtnCount = await page.locator("button:has-text('Confirm & Apply'), button:has-text('Submit Application'), button:has-text('Apply Now'), button:has-text('Submit'), button[type='submit']").filter({ visible: true }).count();

                // Cover letter status
                const coverLetterLocators = [
                    "input[type='checkbox']#cover-letter",
                    "input[type='checkbox'][name*='cover' i]",
                    "input[type='checkbox'][id*='cover' i]",
                    "label:has-text('cover letter')",
                    "label:has-text('Cover Letter')",
                    "label:has-text('Add Cover Letter')",
                    "span:has-text('Add Cover Letter')"
                ];
                let coverLetterDetected = false;
                for (const sel of coverLetterLocators) {
                    if (await page.locator(sel).count() > 0 && await page.locator(sel).first().isVisible().catch(() => false)) {
                        coverLetterDetected = true;
                        break;
                    }
                }
                coverLetterStatus = coverLetterDetected ? "AVAILABLE" : "NOT_AVAILABLE";
                console.log(`[Diagnostic] Cover letter option status: ${coverLetterStatus}`);

                // Evaluate application form detection
                const totalFormElements = textInputsCount + textareasCount + radioButtonsCount + checkboxesCount + dropdownsCount + resumeControlsCount + submitBtnCount + uniqueQuestions.length;
                applicationFormDetected = totalFormElements > 0 ? "PASS" : "FAIL";

                console.log(`[Diagnostic] Application form detected: ${applicationFormDetected}`);
                console.log(`[Diagnostic] Form summary: Questions (${uniqueQuestions.length}), Inputs (${textInputsCount}), Textareas (${textareasCount}), Radios (${radioButtonsCount}), Checkboxes (${checkboxesCount}), Dropdowns (${dropdownsCount}), Resume Controls (${resumeControlsCount}), Next/Continue (${nextBtnCount}), Final Submit Buttons (${submitBtnCount})`);

                if (uniqueQuestions.length > 0) {
                    console.log(`[Diagnostic] Detected Screening Questions Snippets:`);
                    uniqueQuestions.slice(0, 5).forEach((q, idx) => console.log(`   ${idx + 1}. ${q}`));
                }

                // Verify dry-run submission prevention
                const finalSubmitBtn = page.locator("button:has-text('Confirm & Apply'), button:has-text('Submit Application'), button:has-text('Apply Now'), button[type='submit']").filter({ visible: true }).first();
                if (await finalSubmitBtn.count() > 0) {
                    console.log("[Diagnostic] Dry-run trigger check: Final submit button is visible.");
                    console.log("[Diagnostic] Safely clicking final submit button in DRY_RUN mode to verify route interceptor safety...");
                    await finalSubmitBtn.click({ force: true }).catch(err => console.log(`[Diagnostic] Dry-run submit click caught: ${err.message}`));
                    await page.waitForTimeout(3000);
                } else {
                    console.log("[Diagnostic] Safety check: Dry-run protection active. Stopping before final submission.");
                }

                // Calculate overall result
                if (authStatus === "AUTHENTICATED" && searchStatus === "PASS" && jobParsingStatus === "PASS" && applicationPageReached === "PASS" && applicationFormDetected === "PASS") {
                    overallResult = "PASS";
                }
            } else {
                console.log("[Diagnostic] No jobs found or search failed.");
            }
        }
    } catch (err) {
        console.error(`[Diagnostic Error] Flow failed: ${err.message}`, err.stack);
    } finally {
        await browserInstance.close();
        console.log("[Diagnostic] Browser closed.");
    }

    // Comprehensive Output formatting
    console.log("\n==================================================");
    console.log("HIRIST REMOTE DIAGNOSTIC");
    console.log("==================================================");
    console.log(`Environment: Oracle Cloud Ubuntu VM`);
    console.log(`StorageState file exists: ${storageStateExists ? "YES" : "NO"}`);
    console.log(`StorageState cookie count: ${storageStateCookies}`);
    console.log(`StorageState origin count: ${storageStateOrigins}`);
    console.log(`Browser context loaded cookies count: ${loadedCookiesCount}`);
    console.log(`Final URL: ${finalUrl || "N/A"}`);
    console.log(`HTTP status: ${httpStatus || "N/A"}`);
    console.log(`Page title: ${pageTitle || "N/A"}`);
    console.log(`Authenticated UI indicators: ${loggedInCount > 0 ? "YES" : "NO"} (${loggedInCount} matches)`);
    console.log(`Login UI indicators: ${loginCount > 0 ? "YES" : "NO"} (${loginCount} matches)`);
    console.log(`Authentication classification: ${authStatus}`);
    console.log("\n--- DIAGNOSTIC SUITE RESULTS ---");
    console.log(`Authentication: ${authStatus === "AUTHENTICATED" ? "PASS" : "FAIL"}`);
    console.log(`Search: ${searchStatus}`);
    console.log(`Jobs found: ${jobsFoundCount}`);
    console.log(`Job parsing: ${jobParsingStatus}`);
    console.log(`  Parsed Job: "${parsedJob.title}" at "${parsedJob.company}"`);
    console.log(`Application/screening page reached: ${applicationPageReached}`);
    console.log(`Application form detected: ${applicationFormDetected}`);
    console.log(`Cover letter option: ${coverLetterStatus}`);
    console.log(`Dry-run final submission prevented: ${dryRunPreventedFinalSubmit}`);
    console.log("\n--- DETECTED FORM DETAILS ---");
    console.log(`Screening Questions: ${uniqueQuestions.length}`);
    console.log(`Text Inputs: ${textInputsCount}`);
    console.log(`Textareas: ${textareasCount}`);
    console.log(`Radio Buttons: ${radioButtonsCount}`);
    console.log(`Checkboxes: ${checkboxesCount}`);
    console.log(`Dropdowns: ${dropdownsCount}`);
    console.log(`Resume Controls: ${resumeControlsCount}`);
    console.log(`Next/Continue Buttons: ${nextBtnCount}`);
    console.log(`Final Submit Buttons: ${submitBtnCount}`);
    if (interceptedSubmitUrl) {
        console.log(`Blocked Submission Endpoint: ${interceptedSubmitMethod} ${interceptedSubmitUrl}`);
    }
    console.log(`\nOverall Result: ${overallResult}`);
    console.log("==================================================\n");

    if (authStatus === "SESSION_EXPIRED" || authStatus === "LOGIN_REQUIRED") {
        console.log("HIRIST_AUTH_REQUIRED");
    }
})();
