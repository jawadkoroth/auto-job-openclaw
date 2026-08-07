const intelligentJobRanker = require("../../router/IntelligentJobRanker");
const logger = require("../../logger").plugin("linkedin");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LinkedInDiscovery {
    /**
     * Search and discover DevOps/Cloud/Platform candidate jobs on LinkedIn
     * @param {Page} page Playwright page instance
     * @param {Object} options Search criteria
     * @returns {Promise<Array<Object>>} Ranked candidate jobs
     */
    async discoverJobs(page, options = {}) {
        const keywords = options.keywords || ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "Infrastructure Engineer"];
        const location = options.location || "India";
        const maxResults = options.maxResults || 25;

        const discoveredJobs = [];
        const seenJobIds = new Set();

        for (const kw of keywords) {
            if (discoveredJobs.length >= maxResults) break;

            const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(location)}&f_AL=true&sortBy=DD`;
            logger.info(`[Discovery] Searching LinkedIn Jobs: ${kw} in ${location}...`);

            try {
                await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await delay(3000);

                // Scroll job list to trigger lazy loading
                for (let i = 0; i < 3; i++) {
                    await page.evaluate(() => {
                        const list = document.querySelector(".jobs-search-results-list") || document.querySelector(".jobs-search__results-list") || window;
                        list.scrollBy(0, 500);
                    }).catch(() => {});
                    await delay(1000);
                }

                // Extract job cards from page
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
                        const companyEl = card.querySelector([
                            ".job-card-container__company-name",
                            ".job-card-container__primary-description",
                            "a.job-card-container__company-name",
                            "a[data-tracking-control-name*='company_name']",
                            "a[href*='/company/']",
                            ".artdeco-entity-lockup__subtitle",
                            ".job-card-container__subtitle"
                        ].join(", "));

                        const metadataItems = Array.from(card.querySelectorAll(".job-card-container__metadata-item, .job-card-container__metadata-wrapper li, .job-card-container__primary-description span"));
                        const metadataTexts = metadataItems.map(el => el.innerText.trim()).filter(Boolean);

                        const title = titleEl ? titleEl.innerText.trim() : "";
                        
                        let rawCompany = companyEl ? companyEl.innerText.trim() : "";
                        if (rawCompany.includes("\n")) rawCompany = rawCompany.split("\n")[0].trim();
                        if (rawCompany.includes("•")) rawCompany = rawCompany.split("•")[0].trim();
                        const company = rawCompany || "Confidential";
                        const companyNormalized = company.toLowerCase().trim().replace(/[^a-z0-9]/g, "");

                        const locationStr = metadataTexts[0] || (card.querySelector(".job-card-container__metadata-item") ? card.querySelector(".job-card-container__metadata-item").innerText.trim() : "India");
                        const dateEl = card.querySelector("time, .job-card-container__footer-item");
                        const postedStr = dateEl ? dateEl.innerText.trim() : "Today";
                        const isEasyApply = Boolean(card.querySelector(".job-card-container__apply-method") || card.textContent.includes("Easy Apply"));

                        // Experience extraction from card text
                        const fullCardText = card.innerText || "";
                        let extractedExp = "";
                        const rangeMatch = fullCardText.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(?:years?|yrs?|yoe)/i);
                        if (rangeMatch) {
                            extractedExp = `${rangeMatch[1]}-${rangeMatch[2]} Yrs`;
                        } else {
                            const plusMatch = fullCardText.match(/(\d+)\s*\+\s*(?:years?|yrs?|yoe)/i) || fullCardText.match(/(?:min|minimum|at least)\s*(\d+)\s*(?:years?|yrs?|yoe)/i);
                            if (plusMatch) {
                                extractedExp = `${plusMatch[1]}+ Yrs`;
                            } else {
                                const textLower = fullCardText.toLowerCase();
                                if (textLower.includes("entry level") || textLower.includes("fresher")) {
                                    extractedExp = "0-2 Yrs";
                                } else if (textLower.includes("associate")) {
                                    extractedExp = "1-3 Yrs";
                                } else if (textLower.includes("mid-senior level") || textLower.includes("mid senior")) {
                                    extractedExp = "2-5 Yrs";
                                } else if (textLower.includes("director") || textLower.includes("executive")) {
                                    extractedExp = "8-15 Yrs";
                                } else {
                                    extractedExp = "2-4 Yrs";
                                }
                            }
                        }

                        return {
                            id: extractedId,
                            title,
                            company,
                            companyNormalized,
                            location: locationStr,
                            postedDate: postedStr,
                            url: extractedId ? `https://www.linkedin.com/jobs/view/${extractedId}/` : (href ? `https://www.linkedin.com${href}` : ""),
                            isEasyApply,
                            applyType: "EASY_APPLY",
                            portal: "linkedin",
                            experience: extractedExp,
                            experienceString: extractedExp
                        };
                    }).filter(c => Boolean(c.id && c.title));
                }).catch(err => {
                    logger.warn(`[Discovery] Card extraction warning: ${err.message}`);
                    return [];
                });

                const { parseExperience } = require("../../router/ExperienceEligibilityFilter");
                for (const job of cardsData) {
                    if (!seenJobIds.has(job.id)) {
                        seenJobIds.add(job.id);
                        const expParsed = parseExperience(job.experience);
                        job.experienceMin = expParsed.min;
                        job.experienceMax = expParsed.max;
                        discoveredJobs.push(job);
                    }
                }

                logger.info(`[Discovery] Keyword '${kw}' yielded ${cardsData.length} job listing(s). Total unique discovered: ${discoveredJobs.length}`);

            } catch (err) {
                logger.error(`[Discovery] Search error for '${kw}': ${err.message}`);
            }
        }

        // Rank candidate jobs using IntelligentJobRanker v2
        logger.info(`[Discovery] Ranking ${discoveredJobs.length} total discovered jobs using IntelligentJobRanker v2...`);
        const rankedJobs = intelligentJobRanker.rankAndSortJobs(discoveredJobs);
        logger.info(`[Discovery] ${rankedJobs.length} eligible jobs after SRE & eligibility filter ranking.`);

        return rankedJobs;
    }
}

module.exports = new LinkedInDiscovery();
