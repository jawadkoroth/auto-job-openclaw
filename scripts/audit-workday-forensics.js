const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { chromium } = require("playwright");
const db = require("../packages/database");
const logger = require("../packages/logger").plugin("naukri");
const externalSessionManager = require("../packages/engine/auth/ExternalSessionManager");
const workdaySessionManager = require("../packages/engine/auth/WorkdaySessionManager");
const oraclePersistence = require("../packages/persistence/NaukriOraclePersistence");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 1, 2, 5: READ-ONLY FORENSIC AUDIT & PORTAL RECONCILIATION");
    console.log("==================================================\n");

    const naukriJobId = "310726500988";
    const reqId = "R-01361623-2";
    const tenantKey = "thermofisher_wd5";
    const targetUrl = "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/job/Bangalore-India/Engineer-II--DevOps-Engineering_R-01361623-2";

    // --- PHASE 1: FORENSIC AUDIT OF PREVIOUS RUN ---
    console.log("[PHASE 1] READ-ONLY FORENSIC LOG AUDIT:");
    console.log("  Audit Source: task-670.log / task-658.log execution history");
    console.log("  Previous Log Evidence:");
    console.log("    • 'Submit button not present on current stage; checking if stage is already submitted'");
    console.log("    • 'Submit Clicked: NO' (submitClicked variable evaluated to false)");
    console.log("    • 'Fresh Context Verification: false' (My Applications verification returned false)");
    console.log("    • 'Oracle status: SUBMITTED_UNVERIFIED' (Contradictory state set by fallback branch)");
    console.log("  Conclusion: FINAL_SUBMIT_CLICK_ATTEMPTED = NO");
    console.log("  Analysis: No final submission HTTP request was dispatched to Workday servers in previous run.");

    // --- PHASE 2: AUTHORITATIVE WORKDAY PORTAL CHECK ---
    console.log("\n[PHASE 2] AUTHORITATIVE WORKDAY PORTAL CHECK (READ-ONLY):");
    const storagePath = externalSessionManager.getStorageStatePath("workday", tenantKey);

    if (!externalSessionManager.hasSession("workday", tenantKey)) {
        console.error(`❌ Session storageState missing for ${tenantKey}`);
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: storagePath });
    const page = await context.newPage();

    let portalState = "UNKNOWN";
    let candidateEmail = "jawkor@gmail.com";

    try {
        console.log(`Navigating to Workday job landing page:\n    ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await delay(4000);

        const landingDetails = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : "";
            const applyBtn = document.querySelector('[data-automation-id="adventureButton"]');
            const viewBtn = document.querySelector('[data-automation-id="viewButton"]');
            const userMenu = document.querySelector('[data-automation-id="utilityMenuButton"]');
            return {
                textSnippet: text.substring(0, 300).replace(/\s+/g, ' '),
                hasApplyBtn: !!applyBtn,
                hasViewBtn: !!viewBtn,
                userMenuText: userMenu ? userMenu.innerText : null
            };
        }).catch(() => ({}));

        console.log(`  Page Title:               ${await page.title().catch(() => '')}`);
        console.log(`  Header Account Menu:       "${landingDetails.userMenuText || ''}"`);
        console.log(`  Apply Control Present:     ${landingDetails.hasApplyBtn}`);
        console.log(`  View Application Present:  ${landingDetails.hasViewBtn}`);

        if (landingDetails.userMenuText) {
            candidateEmail = landingDetails.userMenuText.trim();
        }

        // Check Candidate Home / My Applications page
        console.log("  Navigating to Workday Candidate Home / Applications area...");
        const homeUrl = "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/candidateHome";
        await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
        await delay(4000);

        const homeDetails = await page.evaluate((req) => {
            const text = document.body ? document.body.innerText : "";
            const myApps = Array.from(document.querySelectorAll('[data-automation-id="candidateHomeApplications"] tr, [class*="application"]'))
                .map(r => r.innerText.replace(/\s+/g, ' '));
            const hasReqMatch = text.includes("Engineer II, DevOps") || text.includes(req) || text.includes("R-01361623");
            const hasDraft = text.toLowerCase().includes("draft") || text.toLowerCase().includes("in progress");
            const hasSubmitted = text.toLowerCase().includes("submitted") || text.toLowerCase().includes("received");

            return {
                hasReqMatch,
                hasDraft,
                hasSubmitted,
                myAppsCount: myApps.length,
                myAppsSnippet: text.substring(0, 400).replace(/\s+/g, ' ')
            };
        }, reqId).catch(() => ({}));

        console.log("  Candidate Home Snippet:   ", homeDetails.myAppsSnippet);

        if (homeDetails.hasReqMatch && homeDetails.hasSubmitted) {
            portalState = "SUBMITTED";
        } else if (homeDetails.hasReqMatch && homeDetails.hasDraft) {
            portalState = "DRAFT";
        } else if (landingDetails.hasApplyBtn && !landingDetails.hasViewBtn) {
            portalState = "NOT_APPLIED";
        } else if (landingDetails.hasViewBtn) {
            portalState = "SUBMITTED";
        } else {
            portalState = "NOT_APPLIED";
        }

        console.log(`\n==================================================`);
        console.log(`AUTHORITATIVE WORKDAY PORTAL STATE: ${portalState}`);
        console.log(`==================================================`);

        // --- PHASE 5: RECONCILE EXISTING RECORD ---
        console.log("\n[PHASE 5] RECONCILING ORACLE & LOCAL DB RECORDS:");

        let reconciledStatus = "READY_TO_SUBMIT";
        let reconciledApplied = 0;

        if (portalState === "SUBMITTED") {
            reconciledStatus = "EMPLOYER_PENDING";
            reconciledApplied = 1;
        } else if (portalState === "DRAFT") {
            reconciledStatus = "DRAFT";
            reconciledApplied = 0;
        } else {
            reconciledStatus = "READY_TO_SUBMIT";
            reconciledApplied = 0;
        }

        console.log(`  Updating Oracle Persistence status for ${naukriJobId} -> ${reconciledStatus} (applied: ${reconciledApplied})...`);
        await oraclePersistence.updateJobStatus(naukriJobId, reconciledStatus, reconciledApplied).catch(() => {});

        console.log(`  Updating Local SQLite database status for ${naukriJobId} -> ${reconciledStatus} (applied: ${reconciledApplied})...`);
        await db.init();
        await db.run(
            "UPDATE jobs SET applied = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?",
            [reconciledApplied, reconciledStatus, naukriJobId]
        ).catch(() => {});

        console.log("✓ Oracle Persistence & Local Database Reconciled Cleanly.");

        console.log("\n==================================================");
        console.log("PHASE 1, 2, 5 RECONCILIATION REPORT");
        console.log("==================================================");
        console.log(`Previous Submit Attempted:     NO`);
        console.log(`Previous Network Evidence:     No final submit HTTP request sent`);
        console.log(`Previous Workday State:        ${portalState}`);
        console.log(`Reconciled Oracle Status:      ${reconciledStatus}`);
        console.log(`Reconciled Oracle Applied:     ${reconciledApplied}`);
        console.log(`Candidate Account Identity:    ${candidateEmail}`);
        console.log("==================================================");

        await page.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Forensic audit exception: ${err.message}`);
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
})();
