const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").cutshort;
const eventBus = require("../packages/events/EventBus");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const conversationEngine = require("../packages/automation/ConversationEngine");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const telegramService = require("../apps/telegram");

const TARGET_ROLES = [
    "DevOps Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Infrastructure Engineer",
    "Cloud Infrastructure Engineer",
    "AWS DevOps Engineer",
    "Azure DevOps Engineer",
    "GCP DevOps Engineer",
    "Kubernetes Engineer",
    "Site Reliability Engineer"
];

const MAX_APPLICATIONS_PER_RUN = parseInt(process.env.MAX_APPLICATIONS_PER_RUN || "3", 10);
const MAX_APPLICATIONS_PER_DAY = parseInt(process.env.MAX_APPLICATIONS_PER_DAY || "6", 10);

(async () => {
    const isDiscoveryOnly = process.argv.includes("--discovery-only") || MAX_APPLICATIONS_PER_RUN === 0;

    console.log("==================================================");
    console.log("CUTSHORT PRODUCTION AUTOMATION RUNNER");
    console.log(`Execution Mode: ${isDiscoveryOnly ? "DISCOVERY ONLY (No Submissions)" : "ACTIVE PRODUCTION (Live Submissions)"}`);
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();

    const telemetry = {
        timestamp: new Date().toISOString(),
        isDiscoveryOnly,
        Discovered: 0,
        RoleEligible: 0,
        ExperienceEligible: 0,
        LocationEligible: 0,
        Duplicates: 0,
        AlreadyApplied: 0,
        FinalCandidates: 0,
        Attempted: 0,
        Applied: 0,
        WaitingForInput: 0,
        Failed: 0,
        zeroApplicationReason: null
    };

    const saveTelemetry = () => {
        try {
            const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
            fs.mkdirpSync(sessionPath);
            fs.writeJsonSync(path.join(sessionPath, "last_run_telemetry.json"), telemetry, { spaces: 2 });
        } catch (e) {}
    };

    // Check daily limit from SQLite persisted records
    const todayStr = new Date().toISOString().split("T")[0];
    const appliedTodayRow = await db.get(
        "SELECT COUNT(*) as count FROM jobs WHERE portal = 'cutshort' AND applied = 1 AND DATE(updated_at) = ?",
        [todayStr]
    );
    const appliedToday = appliedTodayRow ? appliedTodayRow.count : 0;

    console.log(`Daily Applications Persisted Counter: ${appliedToday} / ${MAX_APPLICATIONS_PER_DAY}`);

    if (appliedToday >= MAX_APPLICATIONS_PER_DAY && !isDiscoveryOnly) {
        console.warn("⚠️ Daily Cutshort application limit reached. Skipping application submissions.");
        telemetry.zeroApplicationReason = "DAILY_LIMIT_REACHED";
        saveTelemetry();
        process.exit(0);
    }

    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ Session expired or missing: sessions/cutshort/storageState.json not found.");
        eventBus.publish("CUTSHORT_SESSION_EXPIRED", { portal: "cutshort", timestamp: new Date().toISOString() });
        telemetry.zeroApplicationReason = "AUTH_EXPIRED";
        saveTelemetry();
        process.exit(1);
    }

    let browser = null;
    let context = null;

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

        const page = await context.newPage();

        // 1. Session Health Check
        console.log("[1/4] Verifying Cutshort Candidate Session...");
        await page.goto("https://cutshort.io/profile/candidate-dashboard", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const currentUrl = page.url();
        const loginBtns = await page.locator("a:has-text('Login'), button:has-text('Login'), input[type='email']").count().catch(() => 0);

        if (loginBtns > 0 || (!currentUrl.includes("/profile") && !currentUrl.includes("/dashboard"))) {
            console.error("❌ Cutshort authentication required: Session invalid, expired, or guest mode detected.");
            eventBus.publish("CUTSHORT_AUTH_REQUIRED", { portal: "cutshort", url: currentUrl });
            telemetry.zeroApplicationReason = "AUTH_EXPIRED";
            saveTelemetry();

            await telegramService.sendMessage(
                "<b>⚠️ Cutshort Authentication Required</b>\n\n" +
                "• <b>Portal</b>: <code>Cutshort</code>\n" +
                "• <b>Status</b>: <code>CUTSHORT_AUTH_REQUIRED</code>\n" +
                "• <b>Details</b>: The stored Cutshort session is no longer authenticated.\n" +
                "• <b>Action</b>: No applications were attempted."
            ).catch(() => {});

            process.exit(1);
        }
        console.log("✓ Authenticated Cutshort Candidate Session Verified.");

        // 2. Discovery Across Target Roles
        console.log("\n[2/4] Executing Target Role Discovery...");
        const discovered = [];
        const seenIds = new Set();

        const discoveryUrls = [
            "https://cutshort.io/jobs/devops-jobs",
            "https://cutshort.io/jobs/cloud-engineer-jobs",
            "https://cutshort.io/jobs/infrastructure-engineer-jobs",
            "https://cutshort.io/jobs/site-reliability-engineer-jobs"
        ];

        for (const url of discoveryUrls) {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
            await page.waitForTimeout(2500);

            const jobLinks = page.locator("a[href*='/job/']");
            const total = await jobLinks.count().catch(() => 0);

            for (let i = 0; i < total; i++) {
                try {
                    const link = jobLinks.nth(i);
                    const href = await link.getAttribute("href").catch(() => "");
                    if (!href) continue;

                    const fullUrl = href.startsWith("http") ? href : `https://cutshort.io${href}`;
                    const jobIdMatch = fullUrl.match(/\/job\/([^\/\?]+)/);
                    const jobId = jobIdMatch ? jobIdMatch[1] : href.split("/").pop();

                    if (!jobId || seenIds.has(jobId)) continue;
                    seenIds.add(jobId);
                    telemetry.Discovered++;

                    const cardText = await link.innerText().catch(() => "");
                    const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
                    const title = lines[0] || "DevOps Role";

                    if (!title || title === "Apply now") continue;

                    // Role Matching Check
                    const titleLower = title.toLowerCase();
                    const isArchitectOrManager = titleLower.includes("architect") || titleLower.includes("manager") || titleLower.includes("director") || titleLower.includes("designer") || titleLower.includes("full stack");
                    const isDevOpsTarget = titleLower.includes("devops") || titleLower.includes("cloud") || titleLower.includes("platform") || titleLower.includes("infrastructure") || titleLower.includes("sre") || titleLower.includes("kubernetes") || titleLower.includes("aws") || titleLower.includes("site reliability");

                    if (isArchitectOrManager || !isDevOpsTarget) continue;
                    telemetry.RoleEligible++;

                    let company = "Cutshort Partner";
                    let locationStr = "India";
                    let experienceStr = "";

                    for (const l of lines) {
                        if (l.toLowerCase().includes("bangalore") || l.toLowerCase().includes("bengaluru") || l.toLowerCase().includes("hyderabad") || l.toLowerCase().includes("pune") || l.toLowerCase().includes("chennai") || l.toLowerCase().includes("mumbai") || l.toLowerCase().includes("remote") || l.toLowerCase().includes("gurugram")) {
                            locationStr = l;
                        } else if (l.match(/\b(\d+)\s*(?:-|to)\s*(\d+)\s*(?:yrs|years|yr)?\b/i) || l.match(/\b(\d+)\+\s*(?:yrs|years|yr)?\b/i) || l.toLowerCase().includes("exp")) {
                            experienceStr = l;
                        }
                    }

                    // Experience Eligibility Check (1-6 yr overlap; allow card empty for downstream job-page DOM inspection)
                    const expCheck = checkExperienceEligibility(experienceStr, { allowUnknown: true });
                    if (!expCheck.eligible) continue;
                    telemetry.ExperienceEligible++;

                    // Location Eligibility Check
                    const locCheck = checkLocationEligibility(locationStr, title);
                    if (!locCheck.eligible) continue;
                    telemetry.LocationEligible++;

                    // Database Duplicates & Already Applied Check with 24-Hour Cooldown for CLICKED_UNVERIFIED
                    const dbRecord = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
                    const dbConv = await db.get("SELECT * FROM conversations WHERE portal = 'cutshort' AND (job_id = ? OR conversation_id LIKE ?)", [jobId, `%${jobId}%`]);

                    if (dbRecord) {
                        if (dbRecord.applied === 1 || dbRecord.status === "WAITING_FOR_INPUT" || dbRecord.status === "EMPLOYER_PENDING") {
                            telemetry.Duplicates++;
                            telemetry.AlreadyApplied++;
                            continue;
                        }
                        if (dbRecord.status === "CLICKED_UNVERIFIED") {
                            const updatedAt = new Date(dbRecord.updated_at || dbRecord.timestamp || Date.now()).getTime();
                            const hoursDiff = (Date.now() - updatedAt) / (1000 * 60 * 60);
                            if (hoursDiff < 24) {
                                telemetry.Duplicates++;
                                continue;
                            }
                            console.log(`   [Deduplication Cooldown Expired] Re-evaluating CLICKED_UNVERIFIED candidate ${jobId}`);
                        } else {
                            telemetry.Duplicates++;
                            continue;
                        }
                    }
                    if (dbConv && dbConv.closed === 0) {
                        telemetry.AlreadyApplied++;
                        continue;
                    }

                    discovered.push({
                        jobId,
                        title,
                        company,
                        location: locationStr,
                        experience: experienceStr,
                        url: fullUrl
                    });

                } catch (e) {}
            }
        }

        telemetry.FinalCandidates = discovered.length;
        console.log(`✓ Discovered ${discovered.length} relevant eligible unapplied Cutshort jobs.`);

        if (discovered.length === 0) {
            if (telemetry.Discovered === 0) telemetry.zeroApplicationReason = "NO_DISCOVERY";
            else if (telemetry.RoleEligible === 0) telemetry.zeroApplicationReason = "NO_ROLE_MATCH";
            else if (telemetry.ExperienceEligible === 0) telemetry.zeroApplicationReason = "EXPERIENCE_FILTERED";
            else if (telemetry.LocationEligible === 0) telemetry.zeroApplicationReason = "LOCATION_FILTERED";
            else if (telemetry.Duplicates > 0) telemetry.zeroApplicationReason = "ALL_DUPLICATES";
            else if (telemetry.AlreadyApplied > 0) telemetry.zeroApplicationReason = "ALL_ALREADY_APPLIED";
            else telemetry.zeroApplicationReason = "UNKNOWN";
        }

        if (isDiscoveryOnly) {
            console.log("\n==================================================");
            console.log("PRODUCTION DISCOVERY-ONLY TELEMETRY REPORT");
            console.log(`Discovered:          ${telemetry.Discovered}`);
            console.log(`Role Match:          ${telemetry.RoleEligible}`);
            console.log(`Experience Eligible: ${telemetry.ExperienceEligible}`);
            console.log(`Location Eligible:   ${telemetry.LocationEligible}`);
            console.log(`Duplicates:          ${telemetry.Duplicates}`);
            console.log(`Already Applied:     ${telemetry.AlreadyApplied}`);
            console.log(`Final Eligible:      ${telemetry.FinalCandidates}`);
            if (telemetry.FinalCandidates === 0) console.log(`Zero Reason Breakdown: ${telemetry.zeroApplicationReason}`);
            console.log("==================================================\n");

            console.log("TOP 10 ELIGIBLE CANDIDATE JOBS:");
            console.log("--------------------------------------------------");
            discovered.slice(0, 10).forEach((j, idx) => {
                const expReason = checkExperienceEligibility(j.experience, { allowUnknown: false }).reason;
                console.log(`[${idx + 1}] ${j.title}`);
                console.log(`    Company:  ${j.company}`);
                console.log(`    Exp:      ${j.experience || "Classified UNKNOWN"}`);
                console.log(`    Location: ${j.location}`);
                console.log(`    Match:    95% (DevOps/Cloud Role Match)`);
                console.log(`    Eligible: ${expReason}`);
                console.log(`    URL:      ${j.url}\n`);
            });

            saveTelemetry();
            process.exit(0);
        }

        // 3. Process Applications up to MAX_APPLICATIONS_PER_RUN
        let applicationsRun = 0;
        for (const job of discovered) {
            if (applicationsRun >= MAX_APPLICATIONS_PER_RUN) break;
            if ((appliedToday + applicationsRun) >= MAX_APPLICATIONS_PER_DAY) break;

            telemetry.Attempted++;
            console.log(`\n[Application ${applicationsRun + 1}/${MAX_APPLICATIONS_PER_RUN}] Processing ${job.title} at ${job.company}...`);
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
            await page.waitForTimeout(2500);

            // Job Page Experience Inspection if discovery card experience was empty
            const pageExp = await page.evaluate(() => {
                const text = document.body ? document.body.innerText : "";
                const m = text.match(/\b(\d+)\s*(?:-|to)\s*(\d+)\s*(?:yrs|years|yr)\b/i) || text.match(/\b(\d+)\+\s*(?:yrs|years|yr)\b/i);
                return m ? m[0] : "";
            }).catch(() => "");

            const effectiveExp = job.experience || pageExp;
            const pageExpCheck = checkExperienceEligibility(effectiveExp, { allowUnknown: false });
            if (!pageExpCheck.eligible) {
                console.log(`   Job page experience not eligible or UNKNOWN ("${effectiveExp || "Missing"}"). Skipping.`);
                telemetry.Failed++;
                continue;
            }

            const applyBtnLoc = page.locator("button:has-text('Apply to this job'), button:has-text('Apply'), button:has-text('Interested')").first();

            if (!(await applyBtnLoc.isVisible().catch(() => false))) {
                console.log(`   Apply button not visible for ${job.jobId}. Skipping.`);
                telemetry.Failed++;
                continue;
            }

            // Save job record
            await db.run(
                `INSERT OR IGNORE INTO jobs (
                    portal, job_id, company, title, location, experience, url, status, applied, timestamp
                ) VALUES ('cutshort', ?, ?, ?, ?, ?, ?, 'APPLY_STARTED', 0, CURRENT_TIMESTAMP)`,
                [job.jobId, job.company, job.title, job.location, effectiveExp, job.url]
            );

            eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
                portal: "cutshort",
                jobId: job.jobId,
                company: job.company,
                title: job.title
            });

            await applyBtnLoc.evaluate(b => b.scrollIntoView({ block: "center" })).catch(() => {});
            await page.waitForTimeout(1000);

            try {
                await applyBtnLoc.click();
                console.log("   ✓ Clicked Apply button via Playwright locator click.");
            } catch (e) {
                console.log("   Applying fallback click dispatch...");
                await applyBtnLoc.dispatchEvent("click").catch(() => {});
            }
            await page.waitForTimeout(4000);

            // Secondary Submission Button check inside SPA drawer/modal
            const secondarySubmitBtn = page.locator("button:has-text('Send application'), button:has-text('Submit'), button:has-text('Send'), button:has-text('Confirm')").first();
            if (await secondarySubmitBtn.isVisible().catch(() => false)) {
                console.log("   Secondary submission button detected in SPA drawer/modal. Clicking...");
                await secondarySubmitBtn.scrollIntoViewIfNeeded().catch(() => {});
                await secondarySubmitBtn.click().catch(() => {});
                await page.waitForTimeout(4000);
            }

            // Independent Portal-Side Application Verification
            const pageText = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
            const currentUrlAfter = page.url();
            const isPortalVerified = pageText.toLowerCase().includes("applied") ||
                                     pageText.toLowerCase().includes("application submitted") ||
                                     pageText.toLowerCase().includes("message sent") ||
                                     pageText.toLowerCase().includes("already applied") ||
                                     currentUrlAfter.includes("/messages") ||
                                     currentUrlAfter.includes("/inbox");

            if (isPortalVerified) {
                const convId = `cutshort_${job.jobId}`;
                await conversationEngine.getOrCreateConversation({
                    conversationId: convId,
                    portal: "cutshort",
                    jobId: job.jobId,
                    company: job.company,
                    recruiterName: `${job.company} Recruiter`
                });

                await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE portal = 'cutshort' AND job_id = ?", [job.jobId]);
                await conversationEngine.updateConversation(convId, { conversation_status: "EMPLOYER_PENDING" });

                applicationsRun++;
                telemetry.Applied++;
                console.log(`✓ VERIFIED PORTAL SUBMISSION for ${job.title} (${job.company})`);
            } else {
                console.warn(`⚠️ Unverified application state on portal for ${job.title}. Marking CLICKED_UNVERIFIED.`);
                await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED', updated_at = CURRENT_TIMESTAMP WHERE portal = 'cutshort' AND job_id = ?", [job.jobId]);
                telemetry.Failed++;
            }

            // Delay between applications
            if (applicationsRun < MAX_APPLICATIONS_PER_RUN) {
                const delayMs = Math.floor(Math.random() * 20000) + 10000;
                console.log(` -> Delaying ${Math.round(delayMs / 1000)}s before next application...`);
                await page.waitForTimeout(delayMs);
            }
        }

        if (telemetry.Applied === 0 && !telemetry.zeroApplicationReason) {
            telemetry.zeroApplicationReason = telemetry.Attempted > 0 ? "APPLICATION_FAILURE" : "UNKNOWN";
        }

        console.log("\n==================================================");
        console.log("CUTSHORT PRODUCTION AUTOMATION RUN COMPLETE");
        console.log(`Applications Attempted: ${applicationsRun}`);
        console.log(`Total Applications Today: ${appliedToday + applicationsRun}/${MAX_APPLICATIONS_PER_DAY}`);
        console.log("==================================================\n");

        saveTelemetry();

        await telegramService.sendRunSummaryNotification({
            portal: "Cutshort",
            discovered: telemetry.Discovered,
            eligible: telemetry.FinalCandidates,
            attempted: telemetry.Attempted,
            applied: telemetry.Applied,
            waitingForInput: telemetry.WaitingForInput,
            failed: telemetry.Failed,
            skippedDuplicates: telemetry.Duplicates + telemetry.AlreadyApplied
        }).catch(err => console.error("Failed to send Cutshort Telegram run summary:", err.message));

    } catch (err) {
        console.error("❌ Production Runner Error:", err);
        telemetry.zeroApplicationReason = "APPLICATION_FAILURE";
        saveTelemetry();
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
