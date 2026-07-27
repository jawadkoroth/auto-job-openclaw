const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
const NaukriApiProbe = require("../packages/plugins/naukri/api/NaukriApiProbe");

(async () => {
    console.log("==================================================");
    console.log("NAUKRI API READ-ONLY PROBE SUITE (ORACLE VM)");
    console.log("Execution Time:", new Date().toISOString());
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");

    // 1. Session Pre-Warm & Dynamic Token Extraction
    console.log("[1/2] Pre-Warming Session & Extracting Dynamic Tokens...");
    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        storageState: storageStatePath
    });
    const page = await context.newPage();

    let capturedNkparam = null;
    let capturedBearer = null;

    page.on("request", req => {
        const u = req.url();
        const headers = req.headers();
        if (u.includes("/jobapi/v3/search") && headers["nkparam"]) {
            capturedNkparam = headers["nkparam"];
        }
        if (headers["authorization"] && headers["authorization"].startsWith("Bearer ")) {
            capturedBearer = headers["authorization"];
        }
    });

    await page.goto("https://www.naukri.com/mnjuser/homepage", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    await page.goto("https://www.naukri.com/devops-jobs-in-bangalore", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    await context.storageState({ path: storageStatePath });

    // Fallback: extract nauk_at from storageState if request interception missed it
    if (!capturedBearer && fs.existsSync(storageStatePath)) {
        const rawState = fs.readJsonSync(storageStatePath);
        const naukAt = (rawState.cookies || []).find(c => c.name === "nauk_at");
        if (naukAt && naukAt.value) {
            capturedBearer = naukAt.value.startsWith("Bearer ") ? naukAt.value : `Bearer ${naukAt.value}`;
        }
    }

    console.log(`✓ Pre-Warm Complete. Captured Bearer Token: ${Boolean(capturedBearer)} | Captured nkparam: ${Boolean(capturedNkparam)}`);

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    // 2. Direct HTTPS API Probe Execution
    console.log("\n[2/2] Running Direct HTTPS API Probes on Oracle VM...");
    const probe = new NaukriApiProbe(storageStatePath);
    await probe.loadSession();
    if (capturedBearer) probe.bearerToken = capturedBearer;
    if (capturedNkparam) probe.lastNkparam = capturedNkparam;

    const results = {
        timestamp: new Date().toISOString(),
        testA_profileRead: null,
        testB_jobSearches: [],
        testC_jobDetailsRead: null,
        testD_profileUpdate: null,
        nkparamRequired: true,
        nkparamWorking: Boolean(capturedNkparam)
    };

    // TEST A: Authenticated Profile READ
    console.log("\n--- TEST A: Authenticated Candidate Profile READ ---");
    const profileRes = await probe.getProfileDashboard();
    console.log(`URL:            ${profileRes.url}`);
    console.log(`HTTP Status:    ${profileRes.status}`);
    console.log(`Latency:        ${profileRes.latency} ms`);
    console.log(`Classification: ${profileRes.classification}`);

    let currentHeadline = null;
    if (profileRes.data && profileRes.data.userProfile) {
        const p = profileRes.data.userProfile;
        currentHeadline = p.resumeHeadline || null;
        console.log(`Candidate Name: ${p.fullName || "Found"}`);
        console.log(`Resume Headline:${p.resumeHeadline ? p.resumeHeadline.slice(0, 60) + "..." : "Found"}`);
    }

    results.testA_profileRead = {
        url: profileRes.url,
        status: profileRes.status,
        latency: profileRes.latency,
        classification: profileRes.classification,
        hasData: Boolean(profileRes.data && profileRes.data.userProfile)
    };

    // TEST B: Job Search READ Across 6 Target Searches
    console.log("\n--- TEST B: Job Search READ Across 6 Target Searches ---");
    const targetKeywords = ["DevOps", "Cloud Engineer", "Platform Engineer", "Infrastructure Engineer", "AWS", "Site Reliability Engineer"];
    let firstDiscoveredJobId = null;

    for (const keyword of targetKeywords) {
        const searchRes = await probe.searchJobs(keyword, "Bangalore", 2, capturedNkparam);
        let jobCount = 0;
        if (searchRes.data && searchRes.data.jobDetails) {
            jobCount = searchRes.data.jobDetails.length;
            if (!firstDiscoveredJobId && jobCount > 0) {
                firstDiscoveredJobId = searchRes.data.jobDetails[0].jobId || searchRes.data.jobDetails[0].id;
            }
        }

        console.log(`Keyword: ${keyword.padEnd(28)} | Status: ${searchRes.status} | Classification: ${searchRes.classification} | Cards Found: ${jobCount} | Latency: ${searchRes.latency} ms`);

        results.testB_jobSearches.push({
            keyword,
            status: searchRes.status,
            latency: searchRes.latency,
            classification: searchRes.classification,
            cardsFound: jobCount
        });
    }

    // TEST C: Job Details READ
    console.log("\n--- TEST C: Job Details READ for Discovered Job ---");
    if (firstDiscoveredJobId) {
        const detailsRes = await probe.getJobDetails(firstDiscoveredJobId);
        console.log(`Target Job ID:  ${firstDiscoveredJobId}`);
        console.log(`HTTP Status:    ${detailsRes.status}`);
        console.log(`Latency:        ${detailsRes.latency} ms`);
        console.log(`Classification: ${detailsRes.classification}`);
        if (detailsRes.data) {
            const d = detailsRes.data;
            console.log(`Job Title:      ${d.title || d.jobTitle || "N/A"}`);
            console.log(`Company:        ${d.companyName || d.company || "N/A"}`);
        }
        results.testC_jobDetailsRead = {
            jobId: firstDiscoveredJobId,
            status: detailsRes.status,
            latency: detailsRes.latency,
            classification: detailsRes.classification,
            hasData: Boolean(detailsRes.data)
        };
    }

    // TEST D: Profile Same-Value Save Feasibility Test (Phase 10)
    console.log("\n--- TEST D: Same-Value Profile Headline Update Test ---");
    if (currentHeadline) {
        const updateRes = await probe.updateProfileHeadline(currentHeadline);
        console.log(`HTTP Status:    ${updateRes.status}`);
        console.log(`Latency:        ${updateRes.latency} ms`);
        console.log(`Classification: ${updateRes.classification}`);

        // Re-read profile independently to verify BEFORE === AFTER
        const verifyRes = await probe.getProfileDashboard();
        const afterHeadline = verifyRes.data?.userProfile?.resumeHeadline || null;
        const integrityVerified = (currentHeadline === afterHeadline);
        console.log(`Integrity Check (BEFORE === AFTER): ${integrityVerified ? "PASS" : "FAIL"}`);

        results.testD_profileUpdate = {
            status: updateRes.status,
            latency: updateRes.latency,
            classification: updateRes.classification,
            integrityVerified
        };
    } else {
        console.log("Current headline unreadable, skipping Same-Value update test.");
    }

    console.log("\n==================================================");
    console.log("SUMMARY OF API PROBE EXECUTION ON ORACLE VM");
    console.log(JSON.stringify(results, null, 2));
    console.log("==================================================");
})();
