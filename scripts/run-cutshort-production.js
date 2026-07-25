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
        process.exit(0);
    }

    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ Session expired or missing: sessions/cutshort/storageState.json not found.");
        eventBus.publish("CUTSHORT_SESSION_EXPIRED", { portal: "cutshort", timestamp: new Date().toISOString() });
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
            console.error("❌ Cutshort authenticated session invalid or expired.");
            eventBus.publish("CUTSHORT_SESSION_EXPIRED", { portal: "cutshort", url: currentUrl });
            process.exit(1);
        }
        console.log("✓ Authenticated Cutshort Session Verified.");

        // 2. Discovery Across Target Roles
        console.log("\n[2/4] Executing Target Role Discovery...");
        const discovered = [];
        const seenIds = new Set();
        const candidateProfile = await candidateKnowledgeService.getProfile();

        // Direct category page discovery
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

                    const cardText = await link.innerText().catch(() => "");
                    const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
                    const title = lines[0] || "DevOps Role";

                    if (!title || title === "Apply now") continue;

                    // Reject generic non-target roles
                    const titleLower = title.toLowerCase();
                    const isArchitectOrManager = titleLower.includes("architect") || titleLower.includes("manager") || titleLower.includes("director") || titleLower.includes("designer") || titleLower.includes("full stack");
                    const isDevOpsTarget = titleLower.includes("devops") || titleLower.includes("cloud") || titleLower.includes("platform") || titleLower.includes("infrastructure") || titleLower.includes("sre") || titleLower.includes("kubernetes") || titleLower.includes("aws") || titleLower.includes("site reliability");

                    if (isArchitectOrManager || !isDevOpsTarget) continue;

                    let company = "Cutshort Partner";
                    let locationStr = "India";
                    for (const l of lines) {
                        if (l.toLowerCase().includes("bangalore") || l.toLowerCase().includes("bengaluru") || l.toLowerCase().includes("hyderabad") || l.toLowerCase().includes("pune") || l.toLowerCase().includes("chennai") || l.toLowerCase().includes("mumbai") || l.toLowerCase().includes("remote") || l.toLowerCase().includes("gurugram")) {
                            locationStr = l;
                        }
                    }

                    const locCheck = checkLocationEligibility(locationStr, title);
                    if (!locCheck.eligible) continue;

                    // Check DB record
                    const dbRecord = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
                    const dbConv = await db.get("SELECT * FROM conversations WHERE portal = 'cutshort' AND (job_id = ? OR conversation_id LIKE ?)", [jobId, `%${jobId}%`]);

                    if (dbRecord && (dbRecord.applied === 1 || dbRecord.status === "WAITING_FOR_INPUT" || dbRecord.status === "EMPLOYER_PENDING")) continue;
                    if (dbConv && dbConv.closed === 0) continue;

                    discovered.push({
                        jobId,
                        title,
                        company,
                        location: locationStr,
                        url: fullUrl
                    });
                } catch (e) {}
            }
        }

        console.log(`✓ Discovered ${discovered.length} relevant eligible unapplied Cutshort jobs.`);

        if (isDiscoveryOnly) {
            console.log("\n==================================================");
            console.log("PRODUCTION DISCOVERY-ONLY RUN COMPLETE");
            console.log(`Discovered Jobs: ${discovered.length}`);
            console.log("==================================================\n");
            process.exit(0);
        }

        // 3. Process Applications up to MAX_APPLICATIONS_PER_RUN
        let applicationsRun = 0;
        for (const job of discovered) {
            if (applicationsRun >= MAX_APPLICATIONS_PER_RUN) break;
            if ((appliedToday + applicationsRun) >= MAX_APPLICATIONS_PER_DAY) break;

            console.log(`\n[Application ${applicationsRun + 1}/${MAX_APPLICATIONS_PER_RUN}] Processing ${job.title} at ${job.company}...`);
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
            await page.waitForTimeout(2500);

            const applyBtnLoc = page.locator("button:has-text('Apply to this job'), button:has-text('Apply'), button:has-text('Interested')").first();

            if (!(await applyBtnLoc.isVisible().catch(() => false))) {
                console.log(`   Apply button not visible for ${job.jobId}. Skipping.`);
                continue;
            }

            // Save job record
            await db.run(
                `INSERT OR IGNORE INTO jobs (
                    portal, job_id, company, title, location, url, status, applied, timestamp
                ) VALUES ('cutshort', ?, ?, ?, ?, ?, 'APPLY_STARTED', 0, CURRENT_TIMESTAMP)`,
                [job.jobId, job.company, job.title, job.location, job.url]
            );

            eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
                portal: "cutshort",
                jobId: job.jobId,
                company: job.company,
                title: job.title
            });

            await applyBtnLoc.scrollIntoViewIfNeeded().catch(() => {});
            await applyBtnLoc.evaluate(b => b.click()).catch(() => {});
            await page.waitForTimeout(3000);

            // Create conversation
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
            console.log(`✓ Application ${applicationsRun} submitted for ${job.title} (${job.company})`);

            // Randomized delay between 10s and 30s
            if (applicationsRun < MAX_APPLICATIONS_PER_RUN) {
                const delayMs = Math.floor(Math.random() * 20000) + 10000;
                console.log(` -> Delaying ${Math.round(delayMs / 1000)}s before next application...`);
                await page.waitForTimeout(delayMs);
            }
        }

        console.log("\n==================================================");
        console.log("CUTSHORT PRODUCTION AUTOMATION RUN COMPLETE");
        console.log(`Applications Attempted: ${applicationsRun}`);
        console.log(`Total Applications Today: ${appliedToday + applicationsRun}/${MAX_APPLICATIONS_PER_DAY}`);
        console.log("==================================================\n");

    } catch (err) {
        console.error("❌ Production Runner Error:", err);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
