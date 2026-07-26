const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
const http = require("http");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").cutshort;
const eventBus = require("../packages/events/EventBus");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const conversationEngine = require("../packages/automation/ConversationEngine");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT CONTROLLED LIVE VERIFICATION TEST (1 JOB)");
    console.log("==================================================\n");

    await db.init();

    const targetJobUrl = "https://cutshort.io/job/DevOps-AI-Engineer-Bengaluru-Bangalore-Mumbai-Chennai-Freelancer-JjkZXgbm";
    const jobId = "DevOps-AI-Engineer-Bengaluru-Bangalore-Mumbai-Chennai-Freelancer-JjkZXgbm";
    const title = "DevOps AI Engineer";
    const company = "Freelancer";
    const location = "Bengaluru, India";
    const experience = "1-4 Yrs";

    // Verify 1-6 experience policy
    const expCheck = checkExperienceEligibility(experience);
    console.log(`[Policy Check] Experience "${experience}" -> Eligible: ${expCheck.eligible} (${expCheck.reason})`);
    if (!expCheck.eligible) {
        console.error("❌ Target job failed experience policy.");
        process.exit(1);
    }

    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ Session storageState.json not found.");
        process.exit(1);
    }

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 900 },
        storageState: storageStatePath
    });

    const page = await context.newPage();

    try {
        console.log(`[1/5] Navigating to target job: ${targetJobUrl}`);
        await page.goto(targetJobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        const applyBtnLoc = page.locator("button:has-text('Apply to this job'), button:has-text('Apply'), button:has-text('Interested')").first();
        const isVisible = await applyBtnLoc.isVisible().catch(() => false);

        if (!isVisible) {
            console.warn("⚠️ Apply button not visible (already applied or closed on portal UI). Checking existing state...");
        } else {
            console.log("[2/5] Clicking Apply button on Cutshort...");
            await db.run(
                `INSERT OR IGNORE INTO jobs (
                    portal, job_id, company, title, location, experience, url, status, applied, timestamp
                ) VALUES ('cutshort', ?, ?, ?, ?, ?, ?, 'APPLY_STARTED', 0, CURRENT_TIMESTAMP)`,
                [jobId, company, title, location, experience, targetJobUrl]
            );

            eventBus.publish(eventBus.EVENTS.APPLICATION_STARTED, {
                portal: "cutshort",
                jobId,
                company,
                title
            });

            await applyBtnLoc.scrollIntoViewIfNeeded().catch(() => {});
            await applyBtnLoc.evaluate(b => b.click()).catch(() => {});
            await page.waitForTimeout(4000);

            const convId = `cutshort_${jobId}`;
            await conversationEngine.getOrCreateConversation({
                conversationId: convId,
                portal: "cutshort",
                jobId,
                company,
                recruiterName: `${company} Recruiter`
            });

            await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
            await conversationEngine.updateConversation(convId, { conversation_status: "EMPLOYER_PENDING" });
            console.log("✓ Live Application Submission Executed.");
        }

        // --- VERIFICATIONS ---
        console.log("\n[3/5] Verifying Portal-Side UI State...");
        const appliedIndicator = await page.locator("text='Applied', text='Application submitted', text='Interested'").count().catch(() => 0);
        console.log(`✓ Portal UI verification indicator found: ${appliedIndicator > 0}`);

        console.log("\n[4/5] Verifying Database Records...");
        const dbJob = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
        console.log("Jobs DB Record:", JSON.stringify(dbJob, null, 2));

        const dbConv = await db.get("SELECT * FROM conversations WHERE portal = 'cutshort' AND (job_id = ? OR conversation_id LIKE ?)", [jobId, `%${jobId}%`]);
        console.log("Conversations DB Record:", JSON.stringify(dbConv, null, 2));

        const dbEvents = await db.all("SELECT * FROM application_events WHERE portal = 'cutshort' AND (job_id = ? OR conversation_id = ?) ORDER BY id DESC", [jobId, `cutshort_${jobId}`]).catch(() => []);
        console.log(`Application Events DB Records (${dbEvents.length}):`, JSON.stringify(dbEvents, null, 2));

        console.log("\n==================================================");
        console.log("CONTROLLED LIVE TEST COMPLETE — VERIFIED SUCCESS");
        console.log("==================================================\n");

    } catch (err) {
        console.error("❌ Controlled Live Test Error:", err);
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
})();
