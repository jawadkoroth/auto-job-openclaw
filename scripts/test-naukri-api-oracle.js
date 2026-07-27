const path = require("path");
const fs = require("fs-extra");
const NaukriApiProbe = require("../packages/plugins/naukri/api/NaukriApiProbe");

(async () => {
    console.log("==================================================");
    console.log("NAUKRI API READ-ONLY PROBE SUITE (ORACLE VM)");
    console.log("Execution Time:", new Date().toISOString());
    console.log("==================================================\n");

    const probe = new NaukriApiProbe();
    const sessionInfo = await probe.loadSession();
    console.log(`[Session Setup] Cookies Loaded: ${sessionInfo.validCookies}/${sessionInfo.totalCookies} | Bearer Token Extracted: ${sessionInfo.hasBearerToken}\n`);

    const results = {
        timestamp: new Date().toISOString(),
        testA_profileRead: null,
        testB_jobSearches: [],
        testC_jobDetailsRead: null
    };

    // TEST A: Profile READ
    console.log("--- TEST A: Authenticated Candidate Profile READ ---");
    const profileRes = await probe.getProfileDashboard();
    console.log(`URL:            ${profileRes.url}`);
    console.log(`HTTP Status:    ${profileRes.status}`);
    console.log(`Latency:        ${profileRes.latency} ms`);
    console.log(`Classification: ${profileRes.classification}`);

    if (profileRes.data && profileRes.data.userProfile) {
        const p = profileRes.data.userProfile;
        console.log(`Profile Name:   ${p.fullName || "Found"}`);
        console.log(`Resume Headline:${p.resumeHeadline ? p.resumeHeadline.slice(0, 60) + "..." : "Found"}`);
    }
    results.testA_profileRead = {
        url: profileRes.url,
        status: profileRes.status,
        latency: profileRes.latency,
        classification: profileRes.classification,
        hasData: Boolean(profileRes.data)
    };

    // TEST B: Job Search READ
    console.log("\n--- TEST B: Job Search READ Across Targets ---");
    const targetKeywords = ["DevOps", "Cloud Engineer", "Platform Engineer", "Infrastructure Engineer", "AWS", "Site Reliability Engineer"];
    let firstDiscoveredJobId = null;

    for (const keyword of targetKeywords) {
        const searchRes = await probe.searchJobs(keyword, "Bangalore", 2);
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

    // TEST C: Job Details READ for ONE discovered job
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
    } else {
        console.log("No job ID available for Test C.");
    }

    console.log("\n==================================================");
    console.log("SUMMARY OF PROBE EXECUTION");
    console.log(JSON.stringify(results, null, 2));
    console.log("==================================================");
})();
