/**
 * Naukri Search Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 * @param {Object} queryOptions 
 */
module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    // Retrieve lists of search options
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["Software Engineer"];
    const locationsList = queryOptions.locationsList || config.search.locations || ["Bangalore"];
    
    const allDiscoveredJobs = [];
    const seenJobIds = new Set();
    
    for (const keywords of keywordsList) {
        for (const location of locationsList) {
            logger.info(`Searching Naukri: keywords="${keywords}", location="${location}"`);
            
            // Build direct SEO URL
            const formattedKeywords = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
            const formattedLoc = location ? `-jobs-in-${location.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-")}` : "-jobs";
            const searchUrl = `https://www.naukri.com/${formattedKeywords}${formattedLoc}`;
            
            logger.info(`Navigating directly to search URL: ${searchUrl}`);
            try {
                await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
            } catch (e) {
                logger.error(`Navigation failed for search URL: ${searchUrl}. Error: ${e.message}`);
                continue;
            }
            
            // Selectors for listing cards
            const jobSelector = "article.jobTuple, div.srp-jobtuple, article.srp-jobtuple, [data-job-id]";
            await page.waitForSelector(jobSelector, { timeout: 15000 }).catch(() => {
                logger.warn("No job card selectors matching on page within timeout.");
            });
            
            const jobListings = page.locator(jobSelector);
            const count = await jobListings.count();
            logger.info(`Found ${count} job cards for keywords "${keywords}" in "${location}".`);
            
            for (let i = 0; i < count; i++) {
                try {
                    const item = jobListings.nth(i);
                    const titleLoc = item.locator("a.title, .title, [class*='title']").first();
                    const title = await titleLoc.textContent();
                    
                    const companyLoc = item.locator(".companyName, .company, a.comp-name, [class*='company']").first();
                    const company = await companyLoc.textContent();
                    
                    const url = await titleLoc.getAttribute("href");
                    if (!url) continue;

                    // Extract unique Job ID
                    let jobId = await item.getAttribute("data-job-id");
                    if (!jobId) {
                        const match = url.match(/-([0-9]{12})\b/);
                        if (match) jobId = match[1];
                        else jobId = url.split("?")[0].split("/").pop();
                    }
                    
                    if (!jobId) {
                        jobId = `naukri-${Buffer.from(url).toString("base64").substring(0, 16)}`;
                    }

                    jobId = jobId.trim();
                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);

                    // Extract Experience
                    const expLoc = item.locator(".expwdde, .experience, span.exp, span.exp-wrap, [class*='experience']").first();
                    const experience = (await expLoc.count() > 0) ? (await expLoc.textContent()) : "0-0 Yrs";
                    
                    // Extract Location (could be list of multiple cities)
                    const locLoc = item.locator(".locWd, .location, span.loc, span.loc-wrap, [class*='location']").first();
                    const jobLocation = (await locLoc.count() > 0) ? (await locLoc.textContent()) : location;
                    
                    // Extract Salary
                    const salLoc = item.locator(".sal, .salary, span.sal, span.sal-wrap, [class*='salary']").first();
                    const salary = (await salLoc.count() > 0) ? (await salLoc.textContent()) : "Not Disclosed";

                    allDiscoveredJobs.push({
                        portal: "naukri",
                        job_id: jobId,
                        title: title.trim(),
                        company: company.trim(),
                        location: jobLocation.trim(),
                        experience: experience.trim(),
                        salary: salary.trim(),
                        url: url
                    });
                } catch (e) {
                    logger.debug(`Failed reading listing card index #${i}: ${e.message}`);
                }
            }
            
            // Random delay between search steps to bypass rate limits
            await page.waitForTimeout(Math.floor(Math.random() * 3000) + 2000);
        }
    }
    
    return allDiscoveredJobs;
};
