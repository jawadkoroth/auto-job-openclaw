const path = require("path");
const { chromium } = require("playwright");
const db = require("../packages/database");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");
const WeWorkRemotelyPlugin = require("../packages/plugins/weworkremotely");
const ExternalApplicationRouter = require("../packages/router/ExternalApplicationRouter");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");

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
    const page = await browser.newPage();

    const logger = {
        info: (msg) => console.log(`[INFO] ${msg}`),
        warn: (msg) => console.log(`[WARN] ${msg}`),
        error: (msg) => console.error(`[ERROR] ${msg}`),
        debug: (msg) => {}
    };

    const plugin = new WeWorkRemotelyPlugin({ logger });

    // Step 1: Job Discovery
    const discovered = await plugin.search(page);

    let countDiscovered = discovered.length;
    let countRelevant = 0;
    let countIndiaEligible = 0;
    let countWorldwideEligible = 0;
    let countApacEligible = 0;
    let countLocationRestricted = 0;
    let countLocationUnknown = 0;

    let countCtaDetected = 0;
    let countResolved = 0;
    let countUnresolved = 0;

    let atsCounts = {
        Greenhouse: 0,
        Lever: 0,
        Workday: 0,
        Ashby: 0,
        SmartRecruiters: 0,
        BambooHR: 0,
        OracleHCM: 0,
        SuccessFactors: 0,
        Taleo: 0,
        GenericCareerPages: 0,
        UnsupportedATS: 0
    };

    let jobsReadyForAutomation = 0;
    let jobsWaitingForInput = 0;
    let jobsRequiringUnsupportedAts = 0;
    let duplicatesCount = 0;

    const readyJobs = [];
    const diagnosticRows = [];

    // Step 2: Relevance, Location & ATS Classification
    for (const job of discovered) {
        const titleLower = job.title.toLowerCase();
        const isRelevant = ["devops", "cloud", "platform", "infrastructure", "sre", "kubernetes", "aws"].some(k => titleLower.includes(k));
        
        if (!isRelevant) continue;
        countRelevant++;

        const locEval = checkLocationEligibility(job.location, job.title);

        if (locEval.category === "WORLDWIDE_ELIGIBLE") {
            countWorldwideEligible++;
            countIndiaEligible++;
        } else if (locEval.category === "INDIA_ELIGIBLE") {
            countIndiaEligible++;
        } else if (locEval.category === "APAC_ELIGIBLE") {
            countApacEligible++;
            countIndiaEligible++;
        } else if (locEval.category === "LOCATION_RESTRICTED") {
            countLocationRestricted++;
            diagnosticRows.push({
                jobId: job.job_id,
                title: job.title.slice(0, 25),
                company: job.company.slice(0, 18),
                location: job.location,
                locCategory: locEval.category,
                ctaFound: "NO",
                finalHostname: "weworkremotely.com",
                atsClass: "Unknown",
                isSupported: "NO",
                reasonUnsupported: "LOCATION_RESTRICTED"
            });
            continue;
        } else {
            countLocationUnknown++;
            diagnosticRows.push({
                jobId: job.job_id,
                title: job.title.slice(0, 25),
                company: job.company.slice(0, 18),
                location: job.location,
                locCategory: "LOCATION_UNKNOWN",
                ctaFound: "NO",
                finalHostname: "weworkremotely.com",
                atsClass: "Unknown",
                isSupported: "NO",
                reasonUnsupported: "LOCATION_ELIGIBILITY_UNRESOLVED"
            });
            continue;
        }

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

        let finalHostname = "weworkremotely.com";
        try { finalHostname = new URL(finalUrl).hostname; } catch (e) {}

        const ctaFound = !finalUrl.includes("weworkremotely.com") ? "YES" : "NO";
        if (ctaFound === "YES") countResolved++; else countUnresolved++;

        let isSupported = "NO";
        let reasonUnsupported = "UNSUPPORTED_ATS";

        if (atsType === "Greenhouse") { atsCounts.Greenhouse++; isSupported = "YES"; }
        else if (atsType === "Lever") { atsCounts.Lever++; isSupported = "YES"; }
        else if (atsType === "Workday") { atsCounts.Workday++; isSupported = "YES"; }
        else if (atsType === "Ashby") { atsCounts.Ashby++; isSupported = "YES"; }
        else if (atsType === "SmartRecruiters") { atsCounts.SmartRecruiters++; isSupported = "YES"; }
        else if (atsType === "BambooHR") { atsCounts.BambooHR++; isSupported = "YES"; }
        else if (atsType.includes("Oracle")) { atsCounts.OracleHCM++; isSupported = "YES"; }
        else if (atsType === "SuccessFactors") { atsCounts.SuccessFactors++; isSupported = "YES"; }
        else if (atsType === "Taleo") { atsCounts.Taleo++; isSupported = "YES"; }
        else if (atsType === "Generic Company Career Page") { atsCounts.GenericCareerPages++; isSupported = "NO"; reasonUnsupported = "GENERIC_CAREER_PAGE"; }
        else { atsCounts.UnsupportedATS++; isSupported = "NO"; }

        if (isSupported === "YES") {
            jobsReadyForAutomation++;
            readyJobs.push(job);
            reasonUnsupported = "NONE";
        } else {
            jobsRequiringUnsupportedAts++;
        }

        diagnosticRows.push({
            jobId: job.job_id,
            title: job.title.slice(0, 25),
            company: job.company.slice(0, 18),
            location: job.location,
            locCategory: locEval.category,
            ctaFound,
            finalHostname,
            atsClass: atsType,
            isSupported,
            reasonUnsupported
        });

        // Insert or update record in database
        await db.run(`
            INSERT INTO jobs (job_id, portal, title, company, location, url, final_application_url, ats, status, is_remote)
            VALUES (?, 'weworkremotely', ?, ?, ?, ?, ?, ?, 'ELIGIBLE', 1)
            ON CONFLICT(job_id) DO UPDATE SET final_application_url = excluded.final_application_url, ats = excluded.ats
        `, [job.job_id, job.title, job.company, job.location, job.url, finalUrl, atsType]).catch(() => {});
    }

    // Output WWR Application Routing Validation Report
    console.log("==================================================");
    console.log("WWR APPLICATION ROUTING VALIDATION");
    console.log("==================================================");
    console.log(`Jobs Discovered:                  ${countDiscovered}`);
    console.log(`Relevant Jobs:                    ${countRelevant}`);
    console.log(`India Eligible:                   ${countIndiaEligible}`);
    console.log(`Worldwide Eligible:               ${countWorldwideEligible}`);
    console.log(`APAC Eligible:                    ${countApacEligible}`);
    console.log(`Location Restricted:              ${countLocationRestricted}`);
    console.log(`Location Unknown:                 ${countLocationUnknown}`);
    console.log(`Duplicates:                       ${duplicatesCount}`);
    console.log(`--------------------------------------------------`);
    console.log(`Apply CTA Detected:               ${countCtaDetected}`);
    console.log(`External Destinations Resolved:   ${countResolved}`);
    console.log(`External Destinations Unresolved: ${countUnresolved}`);
    console.log(`--------------------------------------------------`);
    console.log(`Greenhouse:                       ${atsCounts.Greenhouse}`);
    console.log(`Lever:                            ${atsCounts.Lever}`);
    console.log(`Workday:                          ${atsCounts.Workday}`);
    console.log(`Ashby:                            ${atsCounts.Ashby}`);
    console.log(`SmartRecruiters:                  ${atsCounts.SmartRecruiters}`);
    console.log(`BambooHR:                         ${atsCounts.BambooHR}`);
    console.log(`Oracle HCM:                       ${atsCounts.OracleHCM}`);
    console.log(`SuccessFactors:                   ${atsCounts.SuccessFactors}`);
    console.log(`Taleo:                            ${atsCounts.Taleo}`);
    console.log(`Generic Career Pages:             ${atsCounts.GenericCareerPages}`);
    console.log(`Unsupported ATS:                  ${atsCounts.UnsupportedATS}`);
    console.log(`--------------------------------------------------`);
    console.log(`Jobs Ready For Automation:        ${jobsReadyForAutomation}`);
    console.log(`Jobs Waiting For Input:           ${jobsWaitingForInput}`);
    console.log(`Jobs Requiring Unsupported ATS:   ${jobsRequiringUnsupportedAts}`);
    console.log("==================================================\n");

    console.log("--- 24-Job Routing Diagnostic Table ---");
    console.table(diagnosticRows);

    // Controlled Live Application Stage
    if (!DRY_RUN && ALLOW_LIVE_APPLICATIONS && SINGLE_JOB_ALLOWLIST) {
        console.log(`\n--- Step 3: Controlled Live Application Attempt for Allowlisted Job ID "${SINGLE_JOB_ALLOWLIST}" ---`);
        const targetJob = readyJobs.find(j => j.job_id === SINGLE_JOB_ALLOWLIST || j.job_id.includes(SINGLE_JOB_ALLOWLIST));
        
        if (!targetJob) {
            console.log(`❌ Allowlisted Job ID "${SINGLE_JOB_ALLOWLIST}" not found in ready jobs list or not supported.`);
        } else {
            console.log(`Executing live application for: "${targetJob.title}" at "${targetJob.company}" via ${targetJob.ats}`);
            const result = await plugin.apply(page, targetJob);
            console.log(`Live application result:`, result);
        }
    } else {
        console.log("\nDRY_RUN=true: Discovery Active / Application Automation Inactive. No live submission attempted.");
    }

    await browser.close();
    process.exit(0);
}

runWwrRunner().catch(err => {
    console.error("Runner failure:", err);
    process.exit(1);
});
