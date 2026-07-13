module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps Engineer"];
    const locationsList = queryOptions.locationsList || config.search.locations || ["Bangalore"];

    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    for (const keywords of keywordsList) {
        for (const location of locationsList) {
            logger.info(`Searching Hirist: keywords="${keywords}", location="${location}"`);
            
            const cleanTerm = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
            const searchUrl = `https://www.hirist.tech/search/${cleanTerm}?loc=${encodeURIComponent(location)}`;
            logger.info(`Navigating directly to search URL: ${searchUrl}`);
            try {
                await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
                await page.waitForTimeout(3000);
            } catch (e) {
                logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
                continue;
            }

            const cardSelector = ".joblist-card-v2, .job-box, .job-card";
            await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
                logger.warn("No job cards found on Hirist search results page.");
            });

            const jobCards = page.locator(cardSelector);
            const count = await jobCards.count();
            logger.info(`Found ${count} job cards on Hirist.`);

            for (let i = 0; i < count; i++) {
                try {
                    const card = jobCards.nth(i);
                    const titleLoc = card.locator("a[href*='/j/'], a").first();
                    const url = await titleLoc.getAttribute("href");
                    if (!url) continue;

                    const cardText = await card.innerText();
                    if (!cardText) continue;

                    const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
                    const headerLine = lines[0] || "";
                    const parts = headerLine.split(" - ");
                    const company = parts[0]?.trim() || "Unknown Company";
                    const title = parts.slice(1).join(" - ")?.trim() || headerLine;

                    let jobId = "";
                    const match = url.match(/-([0-9]+)\b/);
                    if (match) jobId = match[1];
                    else jobId = url.split("-").pop().split("?")[0];

                    if (!jobId || isNaN(jobId)) {
                        jobId = `hirist-${Buffer.from(url).toString("base64").substring(0, 16)}`;
                    }

                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);

                    let experience = "2-5 Yrs";
                    let jobLocation = location;
                    for (const line of lines) {
                        if (line.includes("yrs") || line.includes("Years") || line.includes("years") || line.includes("Yr")) {
                            experience = line;
                        } else if (line.toLowerCase().includes("bangalore") || line.toLowerCase().includes("hyderabad") || line.toLowerCase().includes("remote") || line.toLowerCase().includes("chennai") || line.toLowerCase().includes("kochi") || line.toLowerCase().includes("trivandrum")) {
                            jobLocation = line;
                        }
                    }

                    allDiscoveredJobs.push({
                        portal: "hirist",
                        job_id: jobId,
                        title: title.trim(),
                        company: company.trim(),
                        location: jobLocation.trim(),
                        experience: experience.trim(),
                        salary: "Not Disclosed",
                        url: url.startsWith("http") ? url : "https://www.hirist.tech" + url
                    });
                } catch (err) {
                    logger.debug(`Failed reading Hirist job card: ${err.message}`);
                }
            }
            await page.waitForTimeout(2000);
        }
    }

    return allDiscoveredJobs;
};
