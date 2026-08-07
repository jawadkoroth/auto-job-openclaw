const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs-extra");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");
const { checkExperienceEligibility, parseExperience } = require("../packages/router/ExperienceEligibilityFilter");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const LinkedInSessionBootstrap = require("../packages/plugins/linkedin/LinkedInSessionBootstrap");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("LINKEDIN DISCOVERY & ELIGIBILITY AUDIT");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "linkedin", "storageState.json");
    const bootstrapHelper = new LinkedInSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, page } = boot;

    const keywords = ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "Infrastructure Engineer"];
    const location = "India";
    const discoveredJobs = [];
    const seenJobIds = new Set();

    for (const kw of keywords) {
        const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(location)}&f_AL=true&sortBy=DD`;
        console.log(`Searching LinkedIn: '${kw}'...`);

        try {
            await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(3000);

            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => {
                    const list = document.querySelector(".jobs-search-results-list") || document.querySelector(".jobs-search__results-list") || window;
                    list.scrollBy(0, 500);
                }).catch(() => {});
                await delay(1000);
            }

            const cardsData = await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll(".job-card-container, div[data-job-id], .jobs-search-results__list-item"));
                return cards.map(card => {
                    const idAttr = card.getAttribute("data-job-id") || card.getAttribute("data-oc-job-id");
                    const linkEl = card.querySelector("a.job-card-list__title, a.job-card-container__link, a[href*='/jobs/view/']");
                    const href = linkEl ? linkEl.getAttribute("href") : "";

                    let extractedId = idAttr;
                    if (!extractedId && href) {
                        const match = href.match(/\/jobs\/view\/(\d+)/);
                        if (match) extractedId = match[1];
                    }

                    const titleEl = card.querySelector(".job-card-list__title, .job-card-container__link, strong");
                    const companyEl = card.querySelector(".job-card-container__primary-description, .job-card-container__company-name");
                    
                    // Metadata locators for location & date
                    const metadataItems = Array.from(card.querySelectorAll(".job-card-container__metadata-item, .job-card-container__metadata-wrapper li, .job-card-container__primary-description span"));
                    const metadataTexts = metadataItems.map(el => el.innerText.trim()).filter(Boolean);

                    const title = titleEl ? titleEl.innerText.trim() : "";
                    const company = companyEl ? companyEl.innerText.trim() : "";
                    const locationStr = metadataTexts[0] || (card.querySelector(".job-card-container__metadata-item") ? card.querySelector(".job-card-container__metadata-item").innerText.trim() : "");
                    const dateEl = card.querySelector("time, .job-card-container__footer-item");
                    const postedStr = dateEl ? dateEl.innerText.trim() : "Today";
                    const isEasyApply = Boolean(card.querySelector(".job-card-container__apply-method") || card.textContent.includes("Easy Apply"));

                    return {
                        id: extractedId,
                        title,
                        company,
                        location: locationStr,
                        rawMetadata: metadataTexts,
                        postedDate: postedStr,
                        url: extractedId ? `https://www.linkedin.com/jobs/view/${extractedId}/` : (href ? `https://www.linkedin.com${href}` : ""),
                        isEasyApply,
                        applyType: "EASY_APPLY",
                        portal: "linkedin",
                        experience: "1-6 Yrs"
                    };
                }).filter(c => Boolean(c.id && c.title));
            }).catch(err => {
                console.warn(`Card extraction error: ${err.message}`);
                return [];
            });

            for (const job of cardsData) {
                if (!seenJobIds.has(job.id)) {
                    seenJobIds.add(job.id);
                    discoveredJobs.push(job);
                }
            }
        } catch (err) {
            console.error(`Search error for '${kw}': ${err.message}`);
        }
    }

    await browser.close();

    console.log(`\n==================================================`);
    console.log(`AUDIT OF ${discoveredJobs.length} DISCOVERED JOBS`);
    console.log(`==================================================\n`);

    const summary = {
        Discovered: discoveredJobs.length,
        RoleEligible: 0,
        ExperienceEligible: 0,
        LocationEligible: 0,
        RecencyEligible: 0,
        NativeApply: 0,
        EasyApply: 0,
        External: 0,
        RejectedSRE: 0,
        RejectedExperience: 0,
        RejectedLocation: 0,
        RejectedApplyType: 0,
        FinalRanked: 0
    };

    let index = 0;
    for (const job of discoveredJobs) {
        index++;
        const title = job.title || "";
        const company = job.company || "";
        const locationStr = job.location || "";
        const experienceStr = job.experience || "";
        const postedStr = job.postedDate || "";
        const applyTypeCategory = intelligentJobRanker.detectApplyType(job);

        const isSre = intelligentJobRanker.isSreRole(title);
        const expCheck = checkExperienceEligibility(experienceStr);
        const locCheck = checkLocationEligibility(locationStr, title);
        const recencyScore = intelligentJobRanker.calculateRecencyScore(job);

        const rankResult = intelligentJobRanker.rankJob(job);

        // Update counts
        if (!isSre) summary.RoleEligible++;
        if (expCheck.eligible) summary.ExperienceEligible++;
        if (locCheck.eligible) summary.LocationEligible++;
        if (recencyScore > 0) summary.RecencyEligible++;

        if (applyTypeCategory === "NATIVE") summary.NativeApply++;
        else if (applyTypeCategory === "EASY_APPLY") summary.EasyApply++;
        else if (applyTypeCategory === "EXTERNAL") summary.External++;

        if (isSre) summary.RejectedSRE++;
        else if (!expCheck.eligible) summary.RejectedExperience++;
        else if (!locCheck.eligible) summary.RejectedLocation++;

        if (rankResult.isEligible) summary.FinalRanked++;

        console.log(`--- JOB #${index} ---`);
        console.log(`Title:              ${title}`);
        console.log(`Company:            ${company}`);
        console.log(`Location:           "${locationStr}" (Raw Metadata: [${(job.rawMetadata || []).join(", ")}])`);
        console.log(`Experience:         ${experienceStr}`);
        console.log(`Posted Age:         ${postedStr}`);
        console.log(`Apply Type:         ${applyTypeCategory}`);
        console.log(`Parsed Experience:  Min=${expCheck.parsedMin}, Max=${expCheck.parsedMax} (${expCheck.category})`);
        console.log(`Parsed Location:    ${locCheck.category}`);
        console.log(`Parsed Recency:     ${recencyScore} Pts`);
        console.log(`Parsed Role:        SRE_Excluded=${isSre}`);
        console.log(`Eligibility Checks:`);
        console.log(`  Role:             ${!isSre ? "✓" : "✗ (SRE EXCLUDED)"}`);
        console.log(`  Experience:       ${expCheck.eligible ? "✓" : "✗ (" + expCheck.reason + ")"}`);
        console.log(`  Location:         ${locCheck.eligible ? "✓" : "✗ (" + locCheck.reason + ")"}`);
        console.log(`Final Result:       ${rankResult.isEligible ? "ELIGIBLE (Score: " + rankResult.rankScore + ")" : "INELIGIBLE (" + rankResult.ineligibleReason + ")"}`);
        console.log(``);
    }

    console.log("==================================================");
    console.log("AUDIT SUMMARY METRICS");
    console.log("==================================================");
    console.log(`Discovered:          ${summary.Discovered}`);
    console.log(`Role Eligible:       ${summary.RoleEligible}`);
    console.log(`Experience Eligible: ${summary.ExperienceEligible}`);
    console.log(`Location Eligible:   ${summary.LocationEligible}`);
    console.log(`Recency Eligible:    ${summary.RecencyEligible}`);
    console.log(`Native Apply:        ${summary.NativeApply}`);
    console.log(`Easy Apply:          ${summary.EasyApply}`);
    console.log(`External:            ${summary.External}`);
    console.log(`Rejected SRE:        ${summary.RejectedSRE}`);
    console.log(`Rejected Experience: ${summary.RejectedExperience}`);
    console.log(`Rejected Location:   ${summary.RejectedLocation}`);
    console.log(`Rejected Apply Type: ${summary.RejectedApplyType}`);
    console.log(`Final Ranked:        ${summary.FinalRanked}`);
    console.log("==================================================\n");
})();
