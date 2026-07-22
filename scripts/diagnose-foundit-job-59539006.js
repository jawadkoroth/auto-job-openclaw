const db = require("../packages/database");
const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const BrowserInstance = require("../packages/browser/BrowserInstance");
const contextManager = require("../packages/browser/ContextManager");
const fs = require("fs-extra");
const path = require("path");

async function runDiagnostic() {
    await db.init().catch(() => {});

    const job = await db.get("SELECT * FROM jobs WHERE portal = 'foundit' AND (job_id = '59539006' OR id = 872)").catch(() => null);
    const jobUrl = "https://www.linkedin.com/jobs/view/4439452616/";

    const storageStatePath = path.join(process.cwd(), "sessions", "linkedin", "storageState.json");
    const storageStateFileExists = fs.existsSync(storageStatePath);

    const browser = new BrowserInstance("linkedin");
    await browser.launch();
    const storageStateLoaded = browser.storageStateLoaded === true;

    const page = await browser.newPage();

    let authState = "PUBLIC_GUEST";
    let jobAvailable = true;
    let applyControlDetected = false;
    let applyControlText = "N/A";
    let easyApply = false;
    let externalApply = false;
    let applicationMethod = "APPLICATION_URL_UNRESOLVED";
    let popupOpened = false;
    let navigationOccurred = false;
    const redirectChain = [];
    let resolvedDestinationUrl = "N/A";
    let resolvedDestinationHostname = "N/A";
    let destinationIsLinkedIn = true;
    let finalAts = "Unknown";
    let result = "APPLICATION_URL_UNRESOLVED";

    // Track redirect chain via network responses
    page.on("response", response => {
        const url = response.url();
        const status = response.status();
        if (status >= 300 && status <= 399) {
            const loc = response.headers()["location"];
            if (loc) {
                redirectChain.push(`${url} -> ${loc}`);
            }
        }
    });

    try {
        console.log(`[Diagnostic] Navigating to target job: ${jobUrl}`);
        await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
        await page.waitForTimeout(4000);

        // 1. Separate & accurate Auth Classification
        authState = await externalApplicationRouter.classifyLinkedInAuth(page);

        // Update session metadata health based on actual auth verification
        if (authState === "AUTHENTICATED") {
            await contextManager.updateMetadata("linkedin", { sessionHealth: "healthy" }).catch(() => {});
        } else {
            await contextManager.updateMetadata("linkedin", { sessionHealth: "unhealthy" }).catch(() => {});
        }

        const rawHtml = await page.content().catch(() => "");
        const contentLower = rawHtml.toLowerCase();

        // 2. Job Availability Detection
        const unavailableKeywords = [
            "no longer accepting applications",
            "job is closed",
            "this job is no longer available",
            "job expired",
            "posting removed",
            "this job posting is no longer active"
        ];
        for (const kw of unavailableKeywords) {
            if (contentLower.includes(kw)) {
                jobAvailable = false;
                result = "JOB_UNAVAILABLE";
                applicationMethod = "JOB_UNAVAILABLE";
                break;
            }
        }

        // 3. Inspect Apply Control
        if (jobAvailable) {
            // Easy Apply Locators
            const easyApplyLocators = [
                "button:has-text('Easy Apply')",
                ".jobs-apply-button:has-text('Easy Apply')",
                "button[data-is-easy-apply='true']",
                "a[data-is-easy-apply='true']",
                "[aria-label*='Easy Apply' i]"
            ];
            for (const sel of easyApplyLocators) {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                    easyApply = true;
                    applyControlDetected = true;
                    applyControlText = (await btn.innerText().catch(() => "Easy Apply")).trim();
                    applicationMethod = "LINKEDIN_EASY_APPLY";
                    result = "LINKEDIN_EASY_APPLY";
                    resolvedDestinationUrl = page.url();
                    try {
                        resolvedDestinationHostname = new URL(resolvedDestinationUrl).hostname;
                    } catch {}
                    destinationIsLinkedIn = true;
                    finalAts = "LINKEDIN_EASY_APPLY";
                    break;
                }
            }

            // External Apply Locators
            if (!easyApply) {
                const externalApplyLocators = [
                    "button.jobs-apply-button",
                    "a.jobs-apply-button",
                    "button:has-text('Apply')",
                    "a:has-text('Apply')",
                    "a[href*='apply']",
                    "a[data-tracking-control-name*='apply']",
                    "[aria-label*='Apply on company website' i]",
                    "button:has-text('Apply on company website')"
                ];

                for (const sel of externalApplyLocators) {
                    const btn = page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                        const text = (await btn.innerText().catch(() => "Apply")).trim();

                        if (text.toLowerCase().includes("sign in") || text.toLowerCase().includes("log in")) {
                            applicationMethod = "LINKEDIN_AUTH_REQUIRED";
                            result = "LINKEDIN_AUTH_REQUIRED";
                            applyControlText = text;
                            break;
                        }

                        externalApply = true;
                        applyControlDetected = true;
                        applyControlText = text;
                        applicationMethod = "LINKEDIN_EXTERNAL_APPLY";

                        // DRY-RUN RESOLUTION (do NOT submit)
                        console.log(`[Diagnostic] External Apply detected ("${text}"). Performing dry-run resolution...`);
                        
                        let targetUrl = null;
                        const initialUrl = page.url();

                        // Listen for popup or navigation
                        const [popup] = await Promise.all([
                            page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
                            btn.click({ force: true }).catch(() => {})
                        ]);

                        if (popup) {
                            popupOpened = true;
                            await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
                            await popup.waitForTimeout(3000);
                            targetUrl = popup.url();
                            await popup.close().catch(() => {});
                        } else {
                            await page.waitForTimeout(4000);
                            targetUrl = page.url();
                            if (targetUrl !== initialUrl) {
                                navigationOccurred = true;
                            }
                        }

                        if (targetUrl) {
                            resolvedDestinationUrl = targetUrl;
                            try {
                                resolvedDestinationHostname = new URL(resolvedDestinationUrl).hostname;
                            } catch {
                                resolvedDestinationHostname = targetUrl;
                            }
                            destinationIsLinkedIn = externalApplicationRouter.isLinkedInUrl(resolvedDestinationUrl);
                            finalAts = externalApplicationRouter.classifyATS(resolvedDestinationUrl);
                            result = "LINKEDIN_EXTERNAL_APPLY_RESOLVED";
                        } else {
                            result = "EXTERNAL_APPLY_RESOLUTION_FAILED";
                        }
                        break;
                    }
                }
            }

            if (!applyControlDetected && authState === "PUBLIC_GUEST") {
                if (contentLower.includes("sign in to apply") || contentLower.includes("join to apply")) {
                    applicationMethod = "LINKEDIN_AUTH_REQUIRED";
                    result = "LINKEDIN_AUTH_REQUIRED";
                }
            }
        }

    } catch (err) {
        console.error("[Diagnostic] Error:", err.message);
        result = `ERROR: ${err.message}`;
    } finally {
        await browser.close().catch(() => {});
    }

    console.log("\n==================================================");
    console.log("AUTHENTICATED LINKEDIN APPLICATION DIAGNOSTIC");
    console.log("==================================================");
    console.log(`StorageState File Exists: ${storageStateFileExists ? "YES" : "NO"}`);
    console.log(`StorageState Loaded: ${storageStateLoaded ? "YES" : "NO"}`);
    console.log(`Authentication Verified: ${authState}`);
    console.log("");
    console.log(`Job URL: ${jobUrl}`);
    console.log(`Job Available: ${jobAvailable ? "YES" : "NO"}`);
    console.log("");
    console.log(`Apply Control Detected: ${applyControlDetected ? "YES" : "NO"}`);
    console.log(`Apply Control Text: ${applyControlText}`);
    console.log(`Application Method: ${applicationMethod}`);
    console.log("");
    console.log(`Easy Apply: ${easyApply ? "YES" : "NO"}`);
    console.log(`External Apply: ${externalApply ? "YES" : "NO"}`);
    console.log("");
    console.log(`Popup Opened: ${popupOpened ? "YES" : "NO"}`);
    console.log(`Navigation Occurred: ${navigationOccurred ? "YES" : "NO"}`);
    console.log(`Redirect Chain: ${redirectChain.length > 0 ? redirectChain.join(" | ") : "NONE"}`);
    console.log("");
    console.log(`Resolved Destination URL: ${resolvedDestinationUrl}`);
    console.log(`Resolved Destination Hostname: ${resolvedDestinationHostname}`);
    console.log(`Destination Is LinkedIn: ${destinationIsLinkedIn ? "YES" : "NO"}`);
    console.log("");
    console.log(`Final ATS Classification: ${finalAts}`);
    console.log("");
    console.log(`Result: ${result}`);
    console.log("==================================================\n");
}

runDiagnostic().catch(err => {
    console.error("Diagnostic execution error:", err);
    process.exit(1);
});
