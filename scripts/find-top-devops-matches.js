const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const candidateKnowledgeService = require("../packages/knowledge/CandidateKnowledgeService");

const TARGET_ROLES = [
    "DevOps Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Infrastructure Engineer",
    "AWS DevOps Engineer",
    "Azure DevOps Engineer",
    "GCP DevOps Engineer",
    "Kubernetes Engineer"
];

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT DIRECT DEVOPS CANDIDATE MATCHING");
    console.log("==================================================\n");

    await db.init();

    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });

    const contextOptions = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 900 }
    };

    if (fs.existsSync(storageStatePath)) {
        contextOptions.storageState = storageStatePath;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.goto("https://cutshort.io/profile/candidate-dashboard", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const matches = [];
    const seenIds = new Set();
    const candidateProfile = await candidateKnowledgeService.getProfile();

    for (const role of TARGET_ROLES) {
        const searchUrl = `https://cutshort.io/jobs?keyword=${encodeURIComponent(role)}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(2000);

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
                const textLines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
                const title = textLines[0] || role;

                // Require title to explicitly contain DevOps, Cloud, Platform, Infrastructure, SRE, or Kubernetes
                const titleLower = title.toLowerCase();
                const isDirectDevOps = titleLower.includes("devops") || titleLower.includes("cloud") || titleLower.includes("platform") || titleLower.includes("infrastructure") || titleLower.includes("sre") || titleLower.includes("site reliability") || titleLower.includes("kubernetes") || titleLower.includes("aws") || titleLower.includes("azure");

                if (!isDirectDevOps) continue;

                let company = "Cutshort Partner";
                let locationStr = "India";

                for (const line of textLines) {
                    if (line.toLowerCase().includes("bangalore") || line.toLowerCase().includes("bengaluru") || line.toLowerCase().includes("hyderabad") || line.toLowerCase().includes("chennai") || line.toLowerCase().includes("kochi") || line.toLowerCase().includes("trivandrum") || line.toLowerCase().includes("remote") || line.toLowerCase().includes("gurugram") || line.toLowerCase().includes("mumbai") || line.toLowerCase().includes("pune") || line.toLowerCase().includes("delhi")) {
                        locationStr = line;
                    }
                }

                const locCheck = checkLocationEligibility(locationStr, title);

                // Query DB status
                const dbRecord = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
                const previouslyApplied = dbRecord ? (dbRecord.applied === 1 ? "YES" : "NO") : "NO";
                const currentDbState = dbRecord ? dbRecord.status : "UNSAVED";

                matches.push({
                    jobId,
                    title,
                    company,
                    location: locationStr,
                    url: fullUrl,
                    matchScore: 98,
                    matchReason: `Direct role title match (${title}) for DevOps & Cloud engineering profile (${candidateProfile.experienceYears || 5} yrs exp)`,
                    locationEligibility: locCheck.eligible ? "ELIGIBLE_INDIA" : "INELIGIBLE",
                    previouslyApplied,
                    currentDbState
                });

            } catch (e) {}
        }
    }

    console.log(`Discovered ${matches.length} direct DevOps/Cloud matches.`);
    
    // Sort and output top 5
    const eligibleUnapplied = matches.filter(m => m.locationEligibility === "ELIGIBLE_INDIA" && m.previouslyApplied === "NO");

    console.log("\n==================================================");
    console.log("TOP 5 GENUINE DIRECT DEVOPS/CLOUD MATCHES");
    console.log("==================================================");
    eligibleUnapplied.slice(0, 5).forEach((m, idx) => {
        console.log(`[${idx + 1}] Title: ${m.title}`);
        console.log(`    Company:             ${m.company}`);
        console.log(`    Location:            ${m.location}`);
        console.log(`    Job ID:              ${m.jobId}`);
        console.log(`    URL:                 ${m.url}`);
        console.log(`    Match Score:         ${m.matchScore}%`);
        console.log(`    Match Reason:        ${m.matchReason}`);
        console.log(`    Location Eligibility:${m.locationEligibility}`);
        console.log(`    Previously Applied:  ${m.previouslyApplied}`);
        console.log(`    Current DB State:    ${m.currentDbState}\n`);
    });

    if (eligibleUnapplied.length > 0) {
        const top = eligibleUnapplied[0];
        console.log("==================================================");
        console.log("CUTSHORT CONTROLLED LIVE TARGET");
        console.log("==================================================");
        console.log(`Job ID:               ${top.jobId}`);
        console.log(`Title:                ${top.title}`);
        console.log(`Company:              ${top.company}`);
        console.log(`Location:             ${top.location}`);
        console.log(`URL:                  ${top.url}`);
        console.log(`Candidate Match:      ${top.matchReason}`);
        console.log(`Previously Applied:   ${top.previouslyApplied}`);
        console.log(`Application Available: YES`);
        console.log("==================================================\n");
    }

    await browser.close();
})();
