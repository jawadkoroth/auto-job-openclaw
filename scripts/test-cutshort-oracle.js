const { chromium } = require("playwright");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { URL } = require("url");

function checkRawHttp(targetUrl) {
    return new Promise((resolve) => {
        try {
            const u = new URL(targetUrl);
            const client = u.protocol === "https:" ? https : http;
            const req = client.request(targetUrl, {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9"
                },
                timeout: 15000
            }, (res) => {
                resolve({ status: res.statusCode, headers: res.headers });
            });
            req.on("error", (err) => resolve({ status: "ERR", error: err.message }));
            req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT" }); });
            req.end();
        } catch (e) {
            resolve({ status: "INVALID_URL", error: e.message });
        }
    });
}

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT ORACLE COMPATIBILITY TEST (PHASE 1)");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    const report = {
        rawHttp: { status: null, details: null },
        playwrightAccess: { status: false, httpStatus: null, title: null },
        cutshortSearchLoading: { status: false, urlTested: null },
        loginPageAccess: { status: false, urlTested: null },
        existingSessionAvailable: false,
        authRequiredForSearch: false,
        authRequiredForApply: true,
        captchaSecurityDetected: false,
        captchaDetails: [],
        jobCardsExtracted: 0,
        sampleJobs: [],
        paginationSupported: false,
        individualJobPageAccess: false,
        applyButtonDetected: false,
        applyButtonDetails: null,
        applicationType: "UNKNOWN",
        atsDetected: null,
        finalClassification: "BLOCKED_FROM_ORACLE"
    };

    // 1. Raw HTTP accessibility
    console.log("[1/14] Testing Raw HTTP Accessibility...");
    const rawRes = await checkRawHttp("https://cutshort.io");
    report.rawHttp.status = rawRes.status;
    report.rawHttp.details = rawRes.error || `HTTP ${rawRes.status}`;
    console.log(` -> Raw HTTP status for https://cutshort.io: ${report.rawHttp.details}`);

    // 5. Existing session availability check
    console.log("[5/14] Checking Existing Session Availability...");
    const sessionPath = path.join(process.cwd(), "sessions", "cutshort", "storageState.json");
    if (fs.existsSync(sessionPath)) {
        report.existingSessionAvailable = true;
        console.log(` -> Session file found at: ${sessionPath}`);
    } else {
        console.log(" -> No existing storageState.json found for Cutshort.");
    }

    // Launch Chromium / Playwright
    console.log("\n[2/14] Testing Playwright/Chromium Accessibility...");
    let browser, context, page;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });

        const contextOptions = {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 }
        };

        if (report.existingSessionAvailable) {
            contextOptions.storageState = sessionPath;
        }

        context = await browser.newContext(contextOptions);
        page = await context.newPage();

        const gotoRes = await page.goto("https://cutshort.io", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => ({ status: () => "ERR: " + e.message }));
        report.playwrightAccess.httpStatus = typeof gotoRes.status === "function" ? gotoRes.status() : 0;
        report.playwrightAccess.title = await page.title().catch(() => "");
        report.playwrightAccess.status = report.playwrightAccess.httpStatus === 200 || (report.playwrightAccess.httpStatus >= 200 && report.playwrightAccess.httpStatus < 400);

        console.log(` -> Playwright navigation HTTP status: ${report.playwrightAccess.httpStatus}`);
        console.log(` -> Page Title: "${report.playwrightAccess.title}"`);

        // 7. CAPTCHA / Security detection
        console.log("\n[7/14] Checking Security / Anti-bot / CAPTCHA Mechanisms...");
        const pageContent = await page.content().catch(() => "");
        if (pageContent.includes("cf-challenge") || pageContent.includes("Cloudflare") || report.playwrightAccess.title.includes("Just a moment...")) {
            report.captchaSecurityDetected = true;
            report.captchaDetails.push("Cloudflare protection / challenge");
        }
        if (pageContent.includes("g-recaptcha") || pageContent.includes("hcaptcha") || pageContent.includes("cf-turnstile") || pageContent.includes("captcha")) {
            report.captchaSecurityDetected = true;
            report.captchaDetails.push("CAPTCHA widget detected in DOM");
        }
        console.log(` -> CAPTCHA/Security Detected: ${report.captchaSecurityDetected} ${report.captchaDetails.length ? "(" + report.captchaDetails.join(", ") + ")" : ""}`);

        if (report.captchaSecurityDetected && report.playwrightAccess.httpStatus === 403) {
            report.finalClassification = "BLOCKED_FROM_ORACLE";
            console.error("\n❌ Oracle VM IP is hard-blocked by Cutshort security. Stopping.");
        } else {
            // 4. Login page accessibility
            console.log("\n[4/14] Testing Login Page Accessibility...");
            const loginUrl = "https://cutshort.io/login";
            report.loginPageAccess.urlTested = loginUrl;
            const loginNav = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(e => null);
            const loginTitle = await page.title().catch(() => "");
            const loginStatus = loginNav ? loginNav.status() : 0;
            report.loginPageAccess.status = loginStatus === 200 || (loginStatus >= 200 && loginStatus < 400);
            console.log(` -> Login Page HTTP Status: ${loginStatus}, Title: "${loginTitle}"`);

            // 3 & 8. Cutshort job search loading
            console.log("\n[3 & 8/14] Testing Cutshort Job Search Loading...");
            const searchUrlsToTry = [
                "https://cutshort.io/jobs/devops-jobs",
                "https://cutshort.io/jobs?keyword=DevOps",
                "https://cutshort.io/jobs"
            ];

            let activeSearchUrl = "";
            for (const sUrl of searchUrlsToTry) {
                console.log(` -> Trying search URL: ${sUrl}`);
                const nav = await page.goto(sUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => null);
                await page.waitForTimeout(3000);
                const countCards = await page.locator("a[href*='/job/'], .job-card, [class*='jobCard'], [class*='JobCard']").count().catch(() => 0);
                if (countCards > 0 || (nav && nav.status() === 200)) {
                    activeSearchUrl = sUrl;
                    report.cutshortSearchLoading.status = true;
                    report.cutshortSearchLoading.urlTested = sUrl;
                    break;
                }
            }

            if (!activeSearchUrl) {
                activeSearchUrl = "https://cutshort.io/jobs";
                await page.goto(activeSearchUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
                await page.waitForTimeout(3000);
            }

            // 6. Check whether authentication is required for searching
            const currentUrl = page.url();
            report.authRequiredForSearch = currentUrl.includes("/login") || currentUrl.includes("/auth");
            console.log(` -> Auth Required For Job Search: ${report.authRequiredForSearch}`);

            // 9. Job card extraction
            console.log("\n[9/14] Testing Job Card Extraction...");
            const jobLinks = page.locator("a[href*='/job/']");
            const totalLinks = await jobLinks.count().catch(() => 0);
            console.log(` -> Found ${totalLinks} job links on page.`);

            const extractedJobs = [];
            for (let i = 0; i < Math.min(totalLinks, 10); i++) {
                const link = jobLinks.nth(i);
                const href = await link.getAttribute("href").catch(() => "");
                const text = await link.innerText().catch(() => "");
                
                if (href) {
                    const fullUrl = href.startsWith("http") ? href : `https://cutshort.io${href}`;
                    const jobIdMatch = fullUrl.match(/\/job\/([^\/\?]+)/);
                    const jobId = jobIdMatch ? jobIdMatch[1] : href;
                    
                    extractedJobs.push({
                        jobId,
                        title: text.split("\n")[0] || text.trim(),
                        url: fullUrl
                    });
                }
            }

            report.jobCardsExtracted = extractedJobs.length;
            report.sampleJobs = extractedJobs.slice(0, 5);
            console.log(` -> Extracted ${extractedJobs.length} sample job cards.`);
            if (extractedJobs.length > 0) {
                console.log(" -> Sample:", JSON.stringify(extractedJobs[0]));
            }

            // 10. Pagination / Infinite scrolling
            console.log("\n[10/14] Testing Pagination / Infinite Scroll...");
            const initialCount = totalLinks;
            await page.evaluate(() => window.scrollBy(0, 1500));
            await page.waitForTimeout(2500);
            const scrolledCount = await page.locator("a[href*='/job/']").count().catch(() => initialCount);
            const paginationBtnCount = await page.locator("button:has-text('Next'), button:has-text('Load More'), a:has-text('Next'), .pagination").count().catch(() => 0);
            report.paginationSupported = scrolledCount > initialCount || paginationBtnCount > 0;
            console.log(` -> Initial links: ${initialCount}, After scroll: ${scrolledCount}, Pagination buttons: ${paginationBtnCount}`);

            // 11. Individual job page access
            console.log("\n[11/14] Testing Individual Job Page Access...");
            let testJobUrl = extractedJobs.length > 0 ? extractedJobs[0].url : null;
            if (!testJobUrl) {
                testJobUrl = "https://cutshort.io/jobs";
            }

            console.log(` -> Navigating to job detail: ${testJobUrl}`);
            const jobNav = await page.goto(testJobUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => null);
            await page.waitForTimeout(3000);
            const jobTitle = await page.title().catch(() => "");
            report.individualJobPageAccess = jobNav && jobNav.status() === 200;
            console.log(` -> Job Detail Page Access: ${report.individualJobPageAccess} (HTTP ${jobNav ? jobNav.status() : 0}), Title: "${jobTitle}"`);

            // 12. Apply button detection
            console.log("\n[12/14] Testing Apply Button Detection...");
            const applySelectors = [
                "button:has-text('Apply')",
                "a:has-text('Apply')",
                "button:has-text('Interested')",
                "button:has-text('Easy Apply')",
                "[class*='apply-btn']",
                "[class*='Apply']"
            ];

            let foundApplyBtn = null;
            for (const sel of applySelectors) {
                const count = await page.locator(sel).count().catch(() => 0);
                if (count > 0) {
                    const text = await page.locator(sel).first().innerText().catch(() => "");
                    const href = await page.locator(sel).first().getAttribute("href").catch(() => null);
                    foundApplyBtn = { selector: sel, text: text.trim(), href };
                    report.applyButtonDetected = true;
                    report.applyButtonDetails = foundApplyBtn;
                    break;
                }
            }
            console.log(` -> Apply Button Detected: ${report.applyButtonDetected}`, foundApplyBtn || "");

            // 13 & 14. Application Type & ATS Detection
            console.log("\n[13 & 14/14] Determining Application Handling (Native vs External ATS)...");
            if (foundApplyBtn) {
                if (foundApplyBtn.href && (foundApplyBtn.href.includes("greenhouse.io") || foundApplyBtn.href.includes("lever.co") || foundApplyBtn.href.includes("workday.com") || foundApplyBtn.href.includes("bamboohr.com") || foundApplyBtn.href.includes("ashbyhq.com"))) {
                    report.applicationType = "EXTERNAL_ATS";
                    report.atsDetected = foundApplyBtn.href.includes("greenhouse") ? "Greenhouse" : foundApplyBtn.href.includes("lever") ? "Lever" : "Other ATS";
                } else {
                    report.applicationType = "NATIVE";
                }
            } else {
                report.applicationType = "NATIVE_OR_AUTH_REQUIRED";
            }
            console.log(` -> Application Handling Type: ${report.applicationType}`);

            // Classification
            if (report.playwrightAccess.status && report.cutshortSearchLoading.status) {
                if (report.existingSessionAvailable) {
                    report.finalClassification = "AUTHENTICATED_ACCESS_VERIFIED";
                } else {
                    report.finalClassification = "ORACLE_ACCESS_VERIFIED";
                }
            } else {
                report.finalClassification = "BLOCKED_FROM_ORACLE";
            }
        }

    } catch (e) {
        console.error(`❌ Unexpected error in Phase 1 test: ${e.stack}`);
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }

    console.log("\n==================================================");
    console.log("CUTSHORT ORACLE COMPATIBILITY REPORT");
    console.log("==================================================");
    console.log(`1. Raw HTTP Status: ${report.rawHttp.details}`);
    console.log(`2. Playwright Access: ${report.playwrightAccess.status ? "PASS" : "FAIL"} (HTTP ${report.playwrightAccess.httpStatus})`);
    console.log(`3. Cutshort Job Search Loading: ${report.cutshortSearchLoading.status ? "PASS" : "FAIL"}`);
    console.log(`4. Login Page Access: ${report.loginPageAccess.status ? "PASS" : "FAIL"}`);
    console.log(`5. Existing Session Available: ${report.existingSessionAvailable ? "YES" : "NO"}`);
    console.log(`6. Auth Required For Search: ${report.authRequiredForSearch ? "YES" : "NO"}`);
    console.log(`7. CAPTCHA / Security Detected: ${report.captchaSecurityDetected ? "YES" : "NO"}`);
    console.log(`8. Job Search Loading: ${report.cutshortSearchLoading.status ? "PASS" : "FAIL"}`);
    console.log(`9. Job Cards Extracted: ${report.jobCardsExtracted}`);
    console.log(`10. Pagination / Infinite Scroll: ${report.paginationSupported ? "PASS" : "NO_SCROLL"}`);
    console.log(`11. Individual Job Page Access: ${report.individualJobPageAccess ? "PASS" : "FAIL"}`);
    console.log(`12. Apply Button Detected: ${report.applyButtonDetected ? "YES" : "NO"}`);
    console.log(`13. Application Handling: ${report.applicationType}`);
    console.log(`14. ATS Detection: ${report.atsDetected || "N/A"}`);
    console.log("--------------------------------------------------");
    console.log(`FINAL CLASSIFICATION: ${report.finalClassification}`);
    console.log("==================================================\n");

    console.log("JSON_REPORT_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("JSON_REPORT_END");
})();
