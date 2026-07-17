module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps"];
    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    for (const keywords of keywordsList) {
        logger.info(`Searching WeWorkRemotely for keywords: "${keywords}"`);
        
        const searchUrl = `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(keywords)}`;
        logger.info(`Navigating directly to WeWorkRemotely search URL: ${searchUrl}`);
        try {
            await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
            await page.waitForTimeout(3000);
        } catch (e) {
            logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
            continue;
        }

        const cardSelector = "li.new-listing-container";
        await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
            logger.warn("No job listings found matching card selector on WeWorkRemotely.");
        });

        const jobListings = page.locator(cardSelector);
        const count = await jobListings.count();
        logger.info(`Found ${count} job cards on WeWorkRemotely.`);

        for (let i = 0; i < count; i++) {
            try {
                const item = jobListings.nth(i);
                
                const linkLoc = item.locator("a[href*='/remote-jobs/']").first();
                if (await linkLoc.count() === 0) continue;
                let url = await linkLoc.getAttribute("href");
                if (!url) continue;

                if (!url.startsWith("http")) {
                    url = "https://weworkremotely.com" + url;
                }

                const linkText = await linkLoc.innerText();
                if (!linkText) continue;

                const lines = linkText.split("\n").map(l => l.trim()).filter(Boolean);
                const cleanParts = lines.filter(p => {
                    const isDayTag = /^\d+d$/.test(p);
                    const isNew = p.toLowerCase() === "new";
                    const isBoosted = p.toLowerCase().includes("boosted");
                    const isFeatured = p.toLowerCase().includes("featured");
                    const isTop = p.toLowerCase().includes("top 100");
                    return !isDayTag && !isNew && !isBoosted && !isFeatured && !isTop;
                });
                
                const title = cleanParts[0] || "Unknown Title";
                const company = cleanParts[1] || "Unknown Company";
                const jobLocation = cleanParts[2] || "Remote";

                let jobId = "";
                const match = url.match(/\/remote-jobs\/(.*?)$/);
                if (match) jobId = match[1].split("-")[0];

                if (!jobId) {
                    jobId = url.split("/").pop();
                }

                if (!jobId) {
                    jobId = `weworkremotely-${i}-${Buffer.from(title + company).toString("base64").substring(0, 8)}`;
                }

                if (seenJobIds.has(jobId)) continue;
                seenJobIds.add(jobId);

                allDiscoveredJobs.push({
                    portal: "weworkremotely",
                    job_id: jobId,
                    title: title.trim(),
                    company: company.trim(),
                    location: jobLocation.trim(),
                    experience: "2-5 Yrs",
                    salary: "Not Disclosed",
                    url: url
                });
            } catch (err) {
                logger.debug(`Failed reading WeWorkRemotely job card index #${i}: ${err.message}`);
            }
        }
        await page.waitForTimeout(2000);
    }

    return allDiscoveredJobs;
};
