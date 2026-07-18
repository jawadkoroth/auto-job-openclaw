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

        // Setup route interception for absolute safety (no real submissions)
        console.log("[Diagnostic] Registering safety network routing rules...");
        await page.route("**/*", async (route, request) => {
            const url = request.url();
            const method = request.method().toUpperCase();
            if (url.includes("hirist.tech") && (method === "POST" || method === "PUT")) {
                console.log(`[ROUTE BLOCK] Intercepted and aborted ${method} request to: ${url}`);
                return route.abort();
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

        // Run authenticated test flow (Task 5)
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

                // Look for Apply button to open drawer if necessary
                const applyBtnSelector = "button:has-text('Apply'), button.apply-btn, #apply-button, button:has-text('Easy Apply')";
                const applyBtn = page.locator(applyBtnSelector).filter({ visible: true }).first();
                if (await applyBtn.count() > 0) {
                    console.log("[Diagnostic] Click action on primary Apply button to open flow...");
                    await applyBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(4000);
                }

                // Check for cover letter checkbox locators
                const checkboxLocators = [
                    page.locator("input[type='checkbox']#cover-letter"),
                    page.locator("input[type='checkbox'][name*='cover' i]"),
                    page.locator("input[type='checkbox'][id*='cover' i]"),
                    page.locator("label:has-text('cover letter')").locator("input[type='checkbox']"),
                    page.locator("label:has-text('Cover Letter')").locator("input[type='checkbox']"),
                    page.locator("label:has-text('Add Cover Letter')").locator("input[type='checkbox']"),
                    page.locator("label:has-text('Add Cover Letter')"),
                    page.locator("span:has-text('Add Cover Letter')"),
                    page.locator("span:has-text('Add cover letter')")
                ];

                let foundCheckbox = null;
                for (const loc of checkboxLocators) {
                    if (await loc.count() > 0 && await loc.first().isVisible()) {
                        foundCheckbox = loc.first();
                        break;
                    }
                }

                if (foundCheckbox) {
                    coverLetterOptionDetected = "YES";
                    console.log("[Diagnostic] Cover letter checkbox detected.");

                    // Try checking/toggling it
                    const tagName = await foundCheckbox.evaluate(el => el.tagName.toLowerCase()).catch(() => "");
                    const typeAttr = await foundCheckbox.getAttribute("type").catch(() => "");
                    
                    if (tagName === "input" && typeAttr === "checkbox") {
                        let isChecked = await foundCheckbox.isChecked();
                        if (!isChecked) {
                            await foundCheckbox.check().catch(() => {});
                            await page.waitForTimeout(2000);
                            isChecked = await foundCheckbox.isChecked();
                            if (isChecked) {
                                coverLetterEnabled = "YES";
                            }
                        } else {
                            coverLetterEnabled = "YES";
                        }
                    } else {
                        await foundCheckbox.click({ force: true }).catch(() => {});
                        await page.waitForTimeout(2000);
                        coverLetterEnabled = "YES";
                    }

                    // Look for textarea to fill
                    const textareaLocators = [
                        page.locator("textarea[name*='cover' i]"),
                        page.locator("textarea[id*='cover' i]"),
                        page.locator("textarea[placeholder*='cover' i]"),
                        page.locator("textarea[placeholder*='Cover' i]"),
                        page.locator("textarea")
                    ];

                    let foundTextarea = null;
                    for (const loc of textareaLocators) {
                        if (await loc.count() > 0 && await loc.first().isVisible()) {
                            foundTextarea = loc.first();
                            break;
                        }
                    }

                    if (foundTextarea) {
                        console.log("[Diagnostic] Textarea detected. Filling cover letter...");
                        await foundTextarea.fill("This is a dry-run test cover letter for DevOps role validation.").catch(() => {});
                        await page.waitForTimeout(1000);
                        
                        const val = await foundTextarea.inputValue();
                        if (val && val.includes("validation")) {
                            coverLetterFieldFilled = "YES";
                        }
                    }
                } else {
                    console.log("[Diagnostic] Cover letter checkbox not detected.");
                }

                // Verify we do NOT submit
                console.log("[Diagnostic] Safety check: Stopping before final submit.");
                finalSubmitClicked = "NO";
                
                if (searchStatus === "PASS" && jobParsingStatus === "PASS") {
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

    // Summary Output formatting
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
    console.log(`Search: ${searchStatus}`);
    console.log(`Jobs found: ${jobsFoundCount}`);
    console.log(`Job parsing: ${jobParsingStatus}`);
    console.log(`Title: ${parsedJob.title}`);
    console.log(`Company: ${parsedJob.company}`);
    console.log(`Location: ${parsedJob.location}`);
    console.log(`Experience: ${parsedJob.experience}`);
    console.log(`Cover letter option detected: ${coverLetterOptionDetected}`);
    console.log(`Cover letter enabled: ${coverLetterEnabled}`);
    console.log(`Cover letter field filled: ${coverLetterFieldFilled}`);
    console.log(`Final submit clicked: ${finalSubmitClicked}`);
    console.log(`Result: ${overallResult}`);
    console.log("==================================================\n");

    if (authStatus === "SESSION_EXPIRED" || authStatus === "LOGIN_REQUIRED") {
        console.log("HIRIST_AUTH_REQUIRED");
        console.log("\n[Resolution Guide] How to safely recreate persistent Hirist session on Oracle VM:");
        console.log("1. Because the Oracle VM is headless and has no display server (X server), running headed Chromium (HEADFUL_AUTH_SETUP=true) directly on the host will fail.");
        console.log("2. Instead, you can bootstrap the session locally on your headful machine by completing the login successfully, which saves cookies/storageState into your local 'sessions/hirist' directory.");
        console.log("3. Once the local session is established, copy the local 'sessions/hirist/storageState.json' file to the remote Oracle VM path at '/home/ubuntu/automation/sessions/hirist/storageState.json'.");
        console.log("4. Alternatively, you can use a tool like scp to transfer the files securely: \n   scp -i \"<SSH_KEY>\" ./sessions/hirist/storageState.json ubuntu@140.245.212.88:/home/ubuntu/automation/sessions/hirist/storageState.json");
        console.log("==================================================\n");
    }
})();
