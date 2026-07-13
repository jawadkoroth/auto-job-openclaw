module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps Engineer"];
    const locationsList = queryOptions.locationsList || config.search.locations || ["Remote"];

    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    for (const keywords of keywordsList) {
        for (const location of locationsList) {
            logger.info(`Searching Wellfound: keywords="${keywords}", location="${location}"`);
            
            const searchUrl = `https://wellfound.com/jobs?query=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`;
            logger.info(`Navigating directly to search URL: ${searchUrl}`);
            try {
                await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
                await page.waitForTimeout(4000);
            } catch (e) {
                logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
                continue;
            }

            const cardSelector = ".styles_jobCard__2n_5t, .styles_jobCard__3X0sL, [class*='jobCard'], .job-card";
            await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
                logger.warn("No job cards found on Wellfound search results page.");
            });

            const jobCards = page.locator(cardSelector);
            const count = await jobCards.count();
            logger.info(`Found ${count} job cards on Wellfound.`);

            for (let i = 0; i < count; i++) {
                try {
                    const card = jobCards.nth(i);
                    const titleLoc = card.locator(".styles_title__12a_b, [class*='title'], a[href*='/jobs/']").first();
                    const title = await titleLoc.textContent();

                    const companyLoc = card.locator(".styles_companyName__3S0q_, [class*='companyName'], .styles_name__3N9S0").first();
                    const company = (await companyLoc.count() > 0) ? (await companyLoc.textContent()) : "Unknown Startup";

                    const url = await titleLoc.getAttribute("href");
                    if (!url) continue;

                    let jobId = url.split("-").pop().split("?")[0];
                    if (!jobId || isNaN(jobId)) {
                        jobId = `wellfound-${Buffer.from(url).toString("base64").substring(0, 16)}`;
                    }

                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);

                    const expLoc = card.locator(".styles_experience__3h2pG, [class*='experience']").first();
                    const experience = (await expLoc.count() > 0) ? (await expLoc.textContent()) : "2-5 Yrs";

                    const locLoc = card.locator(".styles_location__1Uj5T, [class*='location']").first();
                    const jobLocation = (await locLoc.count() > 0) ? (await locLoc.textContent()) : location;

                    allDiscoveredJobs.push({
                        portal: "wellfound",
                        job_id: jobId,
                        title: title.trim(),
                        company: company.trim(),
                        location: jobLocation.trim(),
                        experience: experience.trim(),
                        salary: "Not Disclosed",
                        url: url.startsWith("http") ? url : "https://wellfound.com" + url
                    });
                } catch (err) {
                    logger.debug(`Failed reading Wellfound job card: ${err.message}`);
                }
            }
            await page.waitForTimeout(2000);
        }
    }

    return allDiscoveredJobs;
};
