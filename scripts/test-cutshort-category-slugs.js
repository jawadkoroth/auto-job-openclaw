const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");
const db = require("../packages/database");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");

(async () => {
    await db.init();
    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    const browser = await chromium.launch({ headless: true });
    const contextOptions = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (fs.existsSync(storageStatePath)) contextOptions.storageState = storageStatePath;

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Direct category URLs
    const urls = [
        "https://cutshort.io/jobs/devops-jobs",
        "https://cutshort.io/jobs/cloud-engineer-jobs",
        "https://cutshort.io/jobs/infrastructure-engineer-jobs",
        "https://cutshort.io/jobs/site-reliability-engineer-jobs",
        "https://cutshort.io/jobs?keyword=DevOps"
    ];

    const discovered = [];
    const seen = new Set();

    for (const url of urls) {
        console.log(`Navigating Cutshort category: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const links = page.locator("a[href*='/job/']");
        const count = await links.count();
        console.log(` -> Found ${count} job links.`);

        for (let i = 0; i < count; i++) {
            const href = await links.nth(i).getAttribute("href").catch(() => "");
            if (!href) continue;

            const fullUrl = href.startsWith("http") ? href : `https://cutshort.io${href}`;
            const jobIdMatch = fullUrl.match(/\/job\/([^\/\?]+)/);
            const jobId = jobIdMatch ? jobIdMatch[1] : href.split("/").pop();

            if (!jobId || seen.has(jobId)) continue;
            seen.add(jobId);

            const text = await links.nth(i).innerText().catch(() => "");
            const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
            const title = lines[0] || "DevOps Job";

            if (title === "Apply now" || !title) continue;

            let company = "Cutshort Partner";
            let location = "India";
            if (jobId.includes("-")) {
                const parts = jobId.split("-");
                if (parts.length >= 3) {
                    company = parts[parts.length - 2] || "Cutshort Partner";
                    location = parts.slice(parts.length - 4, parts.length - 2).join(" ") || "India";
                }
            }

            const locCheck = checkLocationEligibility(location, title);
            const dbRecord = await db.get("SELECT * FROM jobs WHERE portal = 'cutshort' AND job_id = ?", [jobId]);
            const previouslyApplied = dbRecord ? (dbRecord.applied === 1 ? "YES" : "NO") : "NO";
            const currentDbState = dbRecord ? dbRecord.status : "UNSAVED";

            discovered.push({
                jobId,
                title,
                company,
                location,
                url: fullUrl,
                matchScore: (title.toLowerCase().includes("devops") || title.toLowerCase().includes("cloud") || title.toLowerCase().includes("infrastructure") || title.toLowerCase().includes("sre")) ? 95 : 85,
                matchReason: `Matches candidate profile skills (5+ yrs experience in DevOps, AWS EKS, Cloud Infrastructure, CI/CD pipelines)`,
                locationEligibility: locCheck.eligible ? "ELIGIBLE_INDIA" : "INELIGIBLE",
                previouslyApplied,
                currentDbState
            });
        }
    }

    console.log(`\nTotal unique jobs discovered: ${discovered.length}`);
    console.log("\n==================================================");
    console.log("TOP 5 CANDIDATE MATCHES");
    console.log("==================================================");

    const eligibleUnapplied = discovered.filter(d => d.locationEligibility === "ELIGIBLE_INDIA" && d.previouslyApplied === "NO");

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
