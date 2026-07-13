module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps"];
    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    for (const keywords of keywordsList) {
        logger.info(`Searching RemoteOK for keywords: "${keywords}"`);
        
        const cleanTerm = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        const searchUrl = `https://remoteok.com/remote-${cleanTerm}-jobs`;
        
        logger.info(`Navigating directly to RemoteOK search URL: ${searchUrl}`);
        try {
            await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
        } catch (e) {
            logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
            continue;
        }

        const cardSelector = "tr.job, .job";
        await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
            logger.warn("No job listings found matching card selector on RemoteOK.");
        });

        const jobListings = page.locator(cardSelector);
        const count = await jobListings.count();
        logger.info(`Found ${count} job cards on RemoteOK.`);

        for (let i = 0; i < count; i++) {
            try {
                const item = jobListings.nth(i);
                
                let jobId = await item.getAttribute("data-id");
                if (!jobId) {
                    jobId = await item.getAttribute("id");
                }
                
                const titleLoc = item.locator(".title, h2, a.prevent-default").first();
                const title = await titleLoc.textContent();

                const companyLoc = item.locator("h3[itemprop='name'], h3, .companyName").first();
                const company = await companyLoc.textContent();

                const linkLoc = item.locator("a[href*='/l/'], a[href*='/jobs/'], a.prevent-default").first();
                let url = await linkLoc.getAttribute("href");
                if (url && !url.startsWith("http")) {
                    url = "https://remoteok.com" + url;
                }

                if (!jobId && url) {
                    jobId = url.split("/").pop();
                }

                if (!jobId) {
                    jobId = `remoteok-${i}-${Buffer.from(title + company).toString("base64").substring(0, 8)}`;
                }

                if (seenJobIds.has(jobId)) continue;
                seenJobIds.add(jobId);

                const jobLocation = "Remote";

                allDiscoveredJobs.push({
                    portal: "remoteok",
                    job_id: jobId,
                    title: title.trim(),
                    company: company.trim(),
                    location: jobLocation,
                    experience: "2-5 Yrs",
                    salary: "Not Disclosed",
                    url: url
                });
            } catch (err) {
                logger.debug(`Failed reading RemoteOK job card index #${i}: ${err.message}`);
            }
        }
        await page.waitForTimeout(2000);
    }

    return allDiscoveredJobs;
};
