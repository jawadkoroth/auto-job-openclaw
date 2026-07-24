const { checkLocationEligibility } = require("../../router/LocationEligibilityFilter");
const db = require("../../database");

const TARGET_ROLE_KEYWORDS = [
    "DevOps Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Infrastructure Engineer",
    "Cloud Infrastructure Engineer",
    "AWS DevOps Engineer",
    "Azure DevOps Engineer",
    "GCP DevOps Engineer",
    "Kubernetes Engineer"
];

module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;

    const keywordsList = queryOptions.keywordsList || TARGET_ROLE_KEYWORDS;
    const locationsList = queryOptions.locationsList || ["Bangalore", "Hyderabad", "Chennai", "Kochi", "Thiruvananthapuram", "Remote India"];

    logger.info(`Starting Cutshort Discovery phase across ${keywordsList.length} roles...`);

    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    // Fetch existing cutshort jobs from DB to avoid re-processing duplicate records
    const existingDbJobs = await db.all("SELECT job_id, url FROM jobs WHERE portal = 'cutshort'").catch(() => []);
    for (const eJob of existingDbJobs) {
        if (eJob.job_id) seenJobIds.add(eJob.job_id);
    }

    for (const keyword of keywordsList) {
        const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const searchUrlsToTry = [
            `https://cutshort.io/jobs/${slug}-jobs`,
            `https://cutshort.io/jobs?keyword=${encodeURIComponent(keyword)}`
        ];

        for (const searchUrl of searchUrlsToTry) {
            logger.info(`Navigating Cutshort search URL: ${searchUrl}`);
            try {
                const resp = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await page.waitForTimeout(3000);
                
                if (!resp || resp.status() >= 400) {
                    logger.warn(`Search URL ${searchUrl} returned HTTP ${resp ? resp.status() : "NO_RESP"}`);
                    continue;
                }
            } catch (e) {
                logger.error(`Navigation error for Cutshort search URL ${searchUrl}: ${e.message}`);
                continue;
            }

            const cardSelector = "a[href*='/job/'], .job-card, [class*='JobCard']";
            const jobLinks = page.locator("a[href*='/job/']");
            const count = await jobLinks.count().catch(() => 0);
            logger.info(`Cutshort search for "${keyword}" yielded ${count} job listings.`);

            for (let i = 0; i < count; i++) {
                try {
                    const link = jobLinks.nth(i);
                    const href = await link.getAttribute("href").catch(() => "");
                    if (!href) continue;

                    const fullUrl = href.startsWith("http") ? href : `https://cutshort.io${href}`;
                    const jobIdMatch = fullUrl.match(/\/job\/([^\/\?]+)/);
                    const jobId = jobIdMatch ? jobIdMatch[1] : href.split("/").pop();

                    if (!jobId || seenJobIds.has(jobId)) continue;

                    const cardText = await link.innerText().catch(() => "");
                    const textLines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
                    
                    const title = textLines[0] || keyword;
                    let company = "Cutshort Partner";
                    let locationStr = "India";
                    let experienceStr = "2-5 Yrs";
                    let salaryStr = "Not Disclosed";

                    for (const line of textLines) {
                        if (line.toLowerCase().includes("bangalore") || line.toLowerCase().includes("bengaluru") || line.toLowerCase().includes("hyderabad") || line.toLowerCase().includes("chennai") || line.toLowerCase().includes("kochi") || line.toLowerCase().includes("trivandrum") || line.toLowerCase().includes("remote") || line.toLowerCase().includes("gurugram") || line.toLowerCase().includes("mumbai") || line.toLowerCase().includes("pune")) {
                            locationStr = line;
                        } else if (line.includes("yrs") || line.includes("years") || line.includes("Yr") || line.includes("Experience")) {
                            experienceStr = line;
                        } else if (line.includes("₹") || line.includes("LPA") || line.includes("k") || line.includes("$")) {
                            salaryStr = line;
                        }
                    }

                    // Enforce LocationEligibilityFilter
                    const locCheck = checkLocationEligibility(locationStr, title);
                    if (!locCheck.eligible) {
                        logger.info(`Skipping job ${jobId} due to location eligibility: ${locCheck.reason}`);
                        continue;
                    }

                    seenJobIds.add(jobId);
                    allDiscoveredJobs.push({
                        portal: "cutshort",
                        job_id: jobId,
                        title: title.trim(),
                        company: company.trim(),
                        location: locationStr.trim(),
                        experience: experienceStr.trim(),
                        salary: salaryStr.trim(),
                        url: fullUrl,
                        applied: 0,
                        ignored: 0,
                        status: "DISCOVERED"
                    });

                } catch (cardErr) {
                    logger.debug(`Error extracting Cutshort job card: ${cardErr.message}`);
                }
            }
        }
    }

    logger.info(`Cutshort Discovery completed. Total unique eligible jobs found: ${allDiscoveredJobs.length}`);
    return allDiscoveredJobs;
};
