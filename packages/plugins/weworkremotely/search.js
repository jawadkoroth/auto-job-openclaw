const { checkLocationEligibility } = require("../../router/LocationEligibilityFilter");
const ExternalApplicationRouter = require("../../router/ExternalApplicationRouter");

module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger } = plugin;
    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    logger.info("Starting WeWorkRemotely RSS job discovery...");

    const rssUrl = "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss";

    try {
        const response = await page.request.get(rssUrl, { timeout: 20000 });
        const xmlText = await response.text();
        const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/gi) || [];
        logger.info(`Found ${itemMatches.length} items in WWR DevOps RSS feed.`);

        for (const itemXml of itemMatches) {
            const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || itemXml.match(/<title>(.*?)<\/title>/i);
            const linkMatch = itemXml.match(/<link>(.*?)<\/link>/i);
            const descMatch = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || itemXml.match(/<description>([\s\S]*?)<\/description>/i);
            const regionMatch = itemXml.match(/<region>(.*?)<\/region>/i) || itemXml.match(/<location>(.*?)<\/location>/i);

            if (!titleMatch || !linkMatch) continue;

            const rawTitle = titleMatch[1];
            const url = linkMatch[1];
            let company = "Unknown Company";
            let title = rawTitle;

            if (rawTitle.includes(" is hiring a ")) {
                const parts = rawTitle.split(" is hiring a ");
                company = parts[0].trim();
                title = parts[1].trim();
            } else if (rawTitle.includes(": ")) {
                const parts = rawTitle.split(": ");
                company = parts[0].trim();
                title = parts[1].trim();
            }

            const location = regionMatch ? regionMatch[1].trim() : "Worldwide / Remote";

            let jobId = "";
            const m = url.match(/\/remote-jobs\/(.*?)$/);
            if (m) jobId = m[1].split("-")[0];
            if (!jobId) jobId = url.split("/").pop();

            if (!jobId || seenJobIds.has(jobId)) continue;
            seenJobIds.add(jobId);

            const locationCheck = checkLocationEligibility(location, title);

            // Extract external application links from CDATA description HTML
            const descHtml = descMatch ? descMatch[1] : "";
            const hrefMatches = descHtml.match(/href=["'](https?:\/\/.*?)["']/gi) || [];
            const externalLinks = hrefMatches
                .map(h => h.replace(/href=["']/i, "").replace(/["']$/, ""))
                .filter(l => !l.includes("weworkremotely.com"));

            let detectedAts = "Generic Company Career Page";
            let finalUrl = url;

            for (const extUrl of externalLinks) {
                const classified = ExternalApplicationRouter.classifyATS(extUrl);
                if (classified !== "Unknown") {
                    detectedAts = classified;
                    finalUrl = extUrl;
                    break;
                }
            }

            allDiscoveredJobs.push({
                portal: "weworkremotely",
                job_id: jobId,
                title,
                company,
                location,
                url,
                final_application_url: finalUrl,
                ats: detectedAts,
                is_india_eligible: locationCheck.eligible ? 1 : 0,
                location_category: locationCheck.category,
                location_reason: locationCheck.reason
            });
        }
    } catch (err) {
        logger.error(`RSS feed fetch failed: ${err.message}`);
    }

    logger.info(`Total unique WeWorkRemotely RSS jobs discovered: ${allDiscoveredJobs.length}`);
    return allDiscoveredJobs;
};
