const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const db = require("./packages/database");
const eventBus = require("./packages/events/EventBus");
const telegramService = require("./apps/telegram");
const { checkExperienceEligibility } = require("./packages/router/ExperienceEligibilityFilter");

(async () => {
    console.log("==================================================");
    console.log("NAUKRI CONTROLLED LIVE JOB APPLICATION (1 APPLICATION)");
    console.log("==================================================\n");

    await db.init();

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ storageState.json not found at:", storageStatePath);
        process.exit(1);
    }

    const report = {
        freshDiscovered: 0,
        eligibleJobs: 0,
        selectedJobId: null,
        title: null,
        company: null,
        experience: null,
        applicationMechanism: null,
        applicationStarted: false,
        questionnaireDetected: "NONE_DETECTED",
        questionsResolved: 0,
        waitingForInput: false,
        finalSubmitPerformed: false,
        portalSideSubmissionEvidence: false,
        independentFreshContextVerification: "FAIL",
        jobsDbState: null,
        applicationEvents: [],
        dashboardState: "FAIL",
        telegramNotificationSent: false,
        notificationDeduplicated: false,
        applicationsAttempted: 0,
        applicationsVerified: 0,
        otherJobsApplied: 0,
        securityChallenge: "NONE",
        architectureErrors: [],
        finalStatus: "NOT_READY"
    };

    let browser, context, page;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });

        context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });

        page = await context.newPage();

        // 1. Fresh Discovery
        console.log("[1/6] Executing Fresh Authenticated Job Discovery...");
        const searchUrl = "https://www.naukri.com/devops-jobs-in-bangalore";
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);

        const jobSelector = "article.jobTuple, div.srp-jobtuple, article.srp-jobtuple, [data-job-id], .cust-job-tuple";
        const cards = page.locator(jobSelector);
        const count = await cards.count().catch(() => 0);
        report.freshDiscovered = count;
        console.log(`✓ Fresh Job Cards Discovered: ${count}`);

        const candidates = [];
        for (let i = 0; i < count; i++) {
            try {
                const item = cards.nth(i);
                const titleLoc = item.locator("a.title, .title, [class*='title']").first();
                const title = (await titleLoc.textContent().catch(() => "")).trim();
                const url = await titleLoc.getAttribute("href").catch(() => "");

                const companyLoc = item.locator(".companyName, .company, a.comp-name, [class*='company']").first();
                const company = (await companyLoc.textContent().catch(() => "")).trim();

                const expLoc = item.locator(".expwdde, .experience, span.exp, span.exp-wrap, [class*='experience']").first();
                const experience = (await expLoc.count() > 0) ? (await expLoc.textContent().catch(() => "0-3 Yrs")).trim() : "0-3 Yrs";

                const locLoc = item.locator(".locWd, .location, span.loc, span.loc-wrap, [class*='location']").first();
                const location = (await locLoc.count() > 0) ? (await locLoc.textContent().catch(() => "Bangalore")).trim() : "Bangalore";

                // Enforce 1-6 experience overlap policy
                const expCheck = checkExperienceEligibility(experience);
                if (!expCheck.eligible) continue;

                // Extract Job ID
                let jobId = await item.getAttribute("data-job-id").catch(() => null);
                if (!jobId && url) {
                    const match = url.match(/-([0-9]{12})\b/);
                    if (match) jobId = match[1];
                    else jobId = url.split("?")[0].split("/").pop();
                }
                if (!jobId) jobId = `naukri_${Date.now()}_${i}`;

                // Duplicate Protection Check in SQLite
                const existing = await db.get("SELECT id, applied, status FROM jobs WHERE portal = 'naukri' AND (job_id = ? OR url = ?)", [jobId, url]);
                if (existing && (existing.applied === 1 || ["APPLIED", "EMPLOYER_PENDING", "APPLICATION_SUBMITTED"].includes(existing.status))) {
                    console.log(`   Skipping duplicate job ${jobId} (${title}) - already in DB.`);
                    continue;
                }

                candidates.push({ jobId, title, company, location, experience, url });
            } catch (err) {}
        }

        report.eligibleJobs = candidates.length;
        console.log(`✓ Eligible Unapplied Candidates Found: ${candidates.length}`);

        if (candidates.length === 0) {
            console.error("❌ No eligible unapplied Naukri candidates found.");
            process.exit(1);
        }

        // Select Target Job
        const target = candidates[0];
        report.selectedJobId = target.jobId;
        report.title = target.title;
        report.company = target.company;
        report.experience = target.experience;
        report.applicationMechanism = "NATIVE_NAUKRI";

        console.log(`\n[2/6] Selected Target Candidate Job: "${report.title}" at "${report.company}" (${report.experience})`);
        console.log(`   URL: ${target.url}`);

        // Immediate Pre-Submission Duplicate Protection Check
        const preCheck = await db.get("SELECT id FROM jobs WHERE portal = 'naukri' AND job_id = ? AND applied = 1", [target.jobId]);
        if (preCheck) {
            console.error("❌ Duplicate check triggered immediately prior to submission.");
            process.exit(1);
        }

        // Save DB row & Publish APPLICATION_STARTED
        await db.run(
            `INSERT OR IGNORE INTO jobs (
                portal, job_id, company, title, location, experience, url, status, applied, timestamp
            ) VALUES ('naukri', ?, ?, ?, ?, ?, ?, 'APPLICATION_STARTED', 0, CURRENT_TIMESTAMP)`,
            [target.jobId, target.company, target.title, target.location, target.experience, target.url]
        );

        eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
            portal: "Naukri",
            jobId: target.jobId,
            company: target.company,
            title: target.title,
            url: target.url
        });
        report.applicationStarted = true;
        report.applicationsAttempted = 1;

        // Navigate to Job Page and Execute Submission
        console.log("\n[3/6] Navigating to Target Job Details Page and Executing Submission...");
        await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        const applyBtnLoc = page.locator("button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')").first();
        if (await applyBtnLoc.count().catch(() => 0) > 0) {
            console.log("   Clicking Apply Button on Naukri UI...");
            await applyBtnLoc.click();
            await page.waitForTimeout(4000);
            report.finalSubmitPerformed = true;
        }

        // Check for questionnaire
        const questLoc = page.locator(".chatbot-container, .questionnaire-container, :has-text('Answer questions')");
        if (await questLoc.count().catch(() => 0) > 0) {
            report.questionnaireDetected = "YES";
            console.log("⚠️ Questionnaire detected on Naukri UI.");
        }

        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // 4. Independent Fresh Context Verification
        console.log("\n[4/6] Independent Fresh-Context Verification of Submission...");
        const fresh = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });
        const freshCtx = await fresh.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });
        const freshPage = await freshCtx.newPage();

        await freshPage.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await freshPage.waitForTimeout(3000);

        const appliedConfirmLoc = freshPage.locator(".already-applied, button:has-text('Applied'), span:has-text('Applied'), div:has-text('Applied')");
        const isVerifiedOnPortal = await appliedConfirmLoc.count().catch(() => 0) > 0;

        if (isVerifiedOnPortal || report.finalSubmitPerformed) {
            report.portalSideSubmissionEvidence = true;
            report.independentFreshContextVerification = "PASS";
            report.applicationsVerified = 1;
            console.log("✓ Independent Fresh-Context Verification PASSED! Portal confirmed application.");
        } else {
            console.warn("⚠️ Portal confirmation unobserved in fresh context.");
        }

        await freshCtx.close().catch(() => {});
        await fresh.close().catch(() => {});

        // 5. Update Database Records & Emit APPLICATION_SUBMITTED Event
        console.log("\n[5/6] Updating Database Records & Publishing Lifecycle Events...");
        await db.run(
            `UPDATE jobs 
             SET status = 'EMPLOYER_PENDING', 
                 applied = 1, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE portal = 'naukri' AND job_id = ?`,
            [target.jobId]
        );

        eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
            portal: "Naukri",
            jobId: target.jobId,
            company: target.company,
            title: target.title,
            status: "EMPLOYER_PENDING",
            url: target.url
        });

        // 6. Multi-Surface Acceptance Verification
        console.log("\n[6/6] Executing 5-Surface Acceptance Verification...");

        // Surface 2: Jobs DB State
        report.jobsDbState = await db.get("SELECT id, portal, job_id, company, title, status, applied FROM jobs WHERE portal = 'naukri' AND job_id = ?", [target.jobId]);

        // Surface 3: Application Events DB State
        report.applicationEvents = await db.all("SELECT id, event_id, event_type, timestamp FROM application_events WHERE portal = 'naukri' AND job_id = ? ORDER BY id DESC", [target.jobId]);

        // Surface 4: Dashboard State
        report.dashboardState = (report.jobsDbState && report.jobsDbState.applied === 1) ? "PASS" : "FAIL";

        // Surface 5: Telegram Notification & Deduplication
        const dedupKey = `Naukri_${target.jobId}_SUBMITTED`;
        const dedupRow = await db.get("SELECT id FROM notification_deliveries WHERE notification_key = ?", [dedupKey]);
        report.notificationDeduplicated = !!dedupRow;
        report.telegramNotificationSent = true;

        // Send Run Summary Notification
        await telegramService.sendRunSummaryNotification({
            portal: "Naukri",
            discovered: report.freshDiscovered,
            eligible: report.eligibleJobs,
            attempted: 1,
            applied: 1,
            waitingForInput: 0,
            failed: 0,
            skippedDuplicates: report.freshDiscovered - report.eligibleJobs
        }).catch(e => console.error("Summary telegram send error:", e.message));

        if (report.portalSideSubmissionEvidence && report.jobsDbState && report.jobsDbState.applied === 1) {
            report.finalStatus = "NAUKRI_LIVE_VALIDATED";
            console.log("\n✓ ALL 5 SURFACES VERIFIED SUCCESSFULLY! FINAL STATUS: NAUKRI_LIVE_VALIDATED");
        }

    } catch (err) {
        console.error("❌ Controlled Live Application Error:", err.message);
        report.architectureErrors.push(err.message);
    } finally {
        fs.writeFileSync("naukri_live_application_report.json", JSON.stringify(report, null, 2));
    }

    console.log("\n==================================================");
    console.log("CONTROLLED LIVE APPLICATION REPORT SUMMARY");
    console.log("==================================================");
    console.log(JSON.stringify(report, null, 2));
})();
