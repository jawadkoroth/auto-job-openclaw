const path = require("path");
const { chromium } = require("playwright");
const db = require("../packages/database");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const WeWorkRemotelyPlugin = require("../packages/plugins/weworkremotely");
const ExternalApplicationRouter = require("../packages/router/ExternalApplicationRouter");

const DRY_RUN = process.env.DRY_RUN !== "false";
const ALLOW_LIVE_APPLICATIONS = process.env.ALLOW_LIVE_APPLICATIONS === "true";
const SINGLE_JOB_ALLOWLIST = process.env.SINGLE_JOB_ALLOWLIST || "";

async function runWwrRunner() {
    console.log("==================================================");
    console.log("WE WORK REMOTELY (WWR) PRODUCTION RUNNER");
    console.log("==================================================");
    console.log(`DRY_RUN: ${DRY_RUN}`);
    console.log(`ALLOW_LIVE_APPLICATIONS: ${ALLOW_LIVE_APPLICATIONS}`);
    console.log(`SINGLE_JOB_ALLOWLIST: ${SINGLE_JOB_ALLOWLIST || 'None (Dry Run Mode)'}\n`);

    await db.init();

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    const logger = {
        info: (msg) => console.log(`[INFO] ${msg}`),
        warn: (msg) => console.log(`[WARN] ${msg}`),
        error: (msg) => console.error(`[ERROR] ${msg}`),
        debug: (msg) => {}
    };

    const plugin = new WeWorkRemotelyPlugin({ logger });

    // Step 1: Job Discovery
    console.log("--- Step 1: Job Discovery ---");
    const discovered = await plugin.search(page);

    let totalDiscovered = discovered.length;
    let relevantCount = 0;
    let indiaEligibleCount = 0;
    let locationRejectedCount = 0;
    let duplicatesCount = 0;
    let directAppsCount = 0;
    let externalAtsCount = 0;
    let supportedAtsCount = 0;
    let unsupportedAtsCount = 0;
    let readyToApplyCount = 0;

    const readyJobs = [];

    // Step 2: Relevance & Location Filtering & Deduplication
    console.log("\n--- Step 2: Relevance, Location & ATS Inspection ---");
    for (const job of discovered) {
        const titleLower = job.title.toLowerCase();
        const isRelevant = ["devops", "cloud", "platform", "infrastructure", "sre", "kubernetes", "aws"].some(k => titleLower.includes(k));
        
        if (!isRelevant) continue;
        relevantCount++;

        if (job.is_india_eligible === 0) {
            locationRejectedCount++;
            continue;
        }
        indiaEligibleCount++;

        // Deduplicate against database
        const existing = await db.get(
            "SELECT * FROM jobs WHERE (job_id = ? AND portal = 'weworkremotely') OR url = ?",
            [job.job_id, job.url]
        );

        if (existing && existing.status === 'APPLIED') {
            duplicatesCount++;
            continue;
        }

        const finalUrl = job.final_application_url || job.url;
        const atsType = ExternalApplicationRouter.classifyATS(finalUrl);

        console.log(`[JOB] "${job.title}" at "${job.company}" -> Location: ${job.location} | ATS: ${atsType} | Target URL: ${finalUrl}`);

        job.final_application_url = finalUrl;
        job.ats = atsType;
        job.is_supported_ats = (atsType === "Greenhouse" || atsType === "Lever" || atsType === "Workday" || atsType === "Ashby" || atsType === "SmartRecruiters" || atsType === "BambooHR" || atsType === "LINKEDIN_JOB") ? 1 : 0;

        if (job.is_supported_ats === 1) {
            supportedAtsCount++;
            readyToApplyCount++;
            readyJobs.push(job);
        } else {
            unsupportedAtsCount++;
        }

        externalAtsCount++;

        // Insert / Update job record in database
        await db.run(`
            INSERT INTO jobs (job_id, portal, title, company, location, url, final_application_url, ats, status, is_remote)
            VALUES (?, 'weworkremotely', ?, ?, ?, ?, ?, ?, 'ELIGIBLE', 1)
            ON CONFLICT(job_id) DO UPDATE SET final_application_url = excluded.final_application_url, ats = excluded.ats
        `, [job.job_id, job.title, job.company, job.location, job.url, finalUrl, atsType]).catch(() => {});
    }

    // Output Metrics Report
    console.log("\n==================================================");
    console.log("WE WORK REMOTELY (WWR) DRY RUN METRICS REPORT");
    console.log("==================================================");
    console.log(`Jobs Discovered:            ${totalDiscovered}`);
    console.log(`Relevant Jobs:              ${relevantCount}`);
    console.log(`India Eligible:             ${indiaEligibleCount}`);
    console.log(`Location Rejected:          ${locationRejectedCount}`);
    console.log(`Duplicates Skipped:         ${duplicatesCount}`);
    console.log(`Direct Applications:        ${directAppsCount}`);
    console.log(`External ATS Jobs:          ${externalAtsCount}`);
    console.log(`Supported ATS Jobs:         ${supportedAtsCount}`);
    console.log(`Unsupported ATS Jobs:       ${unsupportedAtsCount}`);
    console.log(`Jobs Ready to Apply:        ${readyToApplyCount}`);
    console.log("==================================================\n");

    // Controlled Live Application Stage
    if (!DRY_RUN && ALLOW_LIVE_APPLICATIONS && SINGLE_JOB_ALLOWLIST) {
        console.log(`--- Step 3: Controlled Live Application Attempt for Allowlisted Job ID "${SINGLE_JOB_ALLOWLIST}" ---`);
        const targetJob = readyJobs.find(j => j.job_id === SINGLE_JOB_ALLOWLIST || j.job_id.includes(SINGLE_JOB_ALLOWLIST));
        
        if (!targetJob) {
            console.log(`❌ Allowlisted Job ID "${SINGLE_JOB_ALLOWLIST}" not found in ready jobs list or not supported.`);
        } else {
            console.log(`Executing live application for: "${targetJob.title}" at "${targetJob.company}" via ${targetJob.ats}`);
            const result = await plugin.apply(page, targetJob);
            console.log(`Live application result:`, result);
        }
    } else {
        console.log("DRY_RUN=true: No live application submitted.");
    }

    await browser.close();
    process.exit(0);
}

runWwrRunner().catch(err => {
    console.error("Runner failure:", err);
    process.exit(1);
});
