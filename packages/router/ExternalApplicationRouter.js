const db = require("../database");
const logger = require("../logger");

class ExternalApplicationRouter {
    /**
     * Checks if URL belongs to LinkedIn domain
     * @param {string} url 
     * @returns {boolean}
     */
    isLinkedInUrl(url) {
        if (!url) return false;
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
        } catch {
            return url.toLowerCase().includes("linkedin.com");
        }
    }

    /**
     * Checks if URL belongs to Indeed domain
     * @param {string} url 
     * @returns {boolean}
     */
    isIndeedUrl(url) {
        if (!url) return false;
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return hostname === "indeed.com" || hostname.endsWith(".indeed.com");
        } catch {
            return url.toLowerCase().includes("indeed.com");
        }
    }

    /**
     * Alias for classifyATS
     * @param {string} url 
     * @returns {string}
     */
    detectAtsType(url) {
        return this.classifyATS(url);
    }

    /**
     * Classify the external URL into known ATS or Intermediary categories
     * @param {string} url 
     * @returns {string} One of: LINKEDIN_JOB, INDEED_JOB, Greenhouse, Lever, Workday, Ashby, SmartRecruiters, SuccessFactors, Oracle Recruiting / Oracle HCM, Taleo, Generic Company Career Page, Unknown
     */
    classifyATS(url) {
        if (!url) return "Unknown";
        
        // HARD INVARIANT: LinkedIn & Indeed URLs must NEVER fall through to Generic or ATS classifications
        if (this.isLinkedInUrl(url)) {
            return "LINKEDIN_JOB";
        }
        if (this.isIndeedUrl(url)) {
            return "INDEED_JOB";
        }

        const lowercaseUrl = url.toLowerCase();

        // Specific ATS Platforms
        if (lowercaseUrl.includes("greenhouse.io") || lowercaseUrl.includes("boards.greenhouse.io") || lowercaseUrl.includes("greenhouse")) {
            return "Greenhouse";
        }
        if (lowercaseUrl.includes("lever.co") || lowercaseUrl.includes("jobs.lever.co")) {
            return "Lever";
        }
        if (lowercaseUrl.includes("myworkdayjobs.com") || lowercaseUrl.includes("workday")) {
            return "Workday";
        }
        if (lowercaseUrl.includes("ashbyhq.com") || lowercaseUrl.includes("ashby")) {
            return "Ashby";
        }
        if (lowercaseUrl.includes("smartrecruiters.com") || lowercaseUrl.includes("smartrecruiters")) {
            return "SmartRecruiters";
        }
        if (lowercaseUrl.includes("successfactors.com") || lowercaseUrl.includes("successfactors") || lowercaseUrl.includes("careers.sf.com")) {
            return "SuccessFactors";
        }
        if (lowercaseUrl.includes("oraclecloud.com") || lowercaseUrl.includes("hcm.oracle.com") || lowercaseUrl.includes("oraclerecruiting") || lowercaseUrl.includes("oracle.com/careers")) {
            return "Oracle Recruiting / Oracle HCM";
        }
        if (lowercaseUrl.includes("taleo.net") || lowercaseUrl.includes("taleo.com") || lowercaseUrl.includes("taleo")) {
            return "Taleo";
        }
        
        // Generic Company Career Page
        if (
            lowercaseUrl.includes("recruitee.com") || 
            lowercaseUrl.includes("bamboohr.com") || 
            lowercaseUrl.includes("breezy.hr") ||
            lowercaseUrl.includes("jobvite.com") ||
            lowercaseUrl.includes("icims.com") ||
            lowercaseUrl.includes("careers.") ||
            lowercaseUrl.includes("/careers/") ||
            lowercaseUrl.includes("/jobs/")
        ) {
            return "Generic Company Career Page";
        }
        
        return "Unknown";
    }

    /**
     * Accurately classifies LinkedIn authentication state
     * @param {import("playwright").Page} page 
     * @returns {Promise<"AUTHENTICATED" | "PUBLIC_GUEST" | "LOGIN_REQUIRED">}
     */
    async classifyLinkedInAuth(page) {
        try {
            const currentUrl = page.url().toLowerCase();

            if (currentUrl.includes("/authwall") || currentUrl.includes("/signup") || currentUrl.includes("/login") || currentUrl.includes("/checkpoint")) {
                return "LOGIN_REQUIRED";
            }

            const passwordField = page.locator("input[type='password'], input[name='session_password']").first();
            if (await passwordField.count() > 0 && await passwordField.isVisible().catch(() => false)) {
                return "LOGIN_REQUIRED";
            }

            // Check for li_at cookie (primary positive signal of genuine LinkedIn auth)
            const cookies = await page.context().cookies().catch(() => []);
            const hasLiAt = cookies.some(c => c.name === "li_at" && c.value && c.value.length > 5);

            // Check for authenticated navigation bar / elements
            const navSelectors = [
                "img.global-nav__me-photo",
                ".global-nav__me",
                "nav.global-nav",
                "#global-nav",
                "button[aria-label*='Me' i]",
                "button[aria-label*='Account' i]",
                "a.global-nav__primary-link",
                "a[href*='/in/']",
                "a[href*='/feed/']"
            ];
            let navDetected = false;
            for (const sel of navSelectors) {
                const el = page.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    navDetected = true;
                    break;
                }
            }

            if (hasLiAt || navDetected) {
                return "AUTHENTICATED";
            }

            const modal = page.locator(".sign-in-modal, form.login__form, iframe[title*='Sign in']").first();
            if (await modal.count() > 0 && await modal.isVisible().catch(() => false)) {
                return "LOGIN_REQUIRED";
            }

            return "PUBLIC_GUEST";
        } catch {
            return "LOGIN_REQUIRED";
        }
    }

    /**
     * Resolves an intermediary platform job page (LinkedIn, Indeed) to its final application destination
     * @param {import("playwright").Page} page 
     * @param {string} initialUrl 
     * @returns {Promise<{ type: string, destinationUrl?: string, ats?: string, reason?: string, routingHistory: Array<{ type: string, platform: string, url: string }> }>}
     */
    async resolveIntermediary(page, initialUrl) {
        const initialClassification = this.classifyATS(initialUrl);

        const routingHistory = [
            { type: "SOURCE", platform: "Portal", url: initialUrl },
            { type: "INTERMEDIARY", platform: initialClassification, url: initialUrl }
        ];

        if (initialClassification !== "LINKEDIN_JOB" && initialClassification !== "INDEED_JOB") {
            return {
                type: "DIRECT_ATS",
                destinationUrl: initialUrl,
                ats: initialClassification,
                routingHistory
            };
        }

        logger.worker.info(`[Intermediary Router] Resolving intermediary platform (${initialClassification}): ${initialUrl}`);

        try {
            if (page.url() !== initialUrl) {
                await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);

            const currentUrl = page.url();
            const content = await page.content().catch(() => "");
            const lowerContent = content.toLowerCase();

            // Task 4: Accurate Authentication Classification
            const authState = await this.classifyLinkedInAuth(page);
            logger.worker.info(`[Intermediary Router] LinkedIn Auth State: ${authState}`);

            if (authState === "LOGIN_REQUIRED") {
                logger.worker.warn(`[Intermediary Router] LinkedIn Authentication Required.`);
                return {
                    type: "LINKEDIN_AUTH_REQUIRED",
                    reason: "LinkedIn login required",
                    routingHistory
                };
            }

            // Task 3: Detect Unavailable Jobs Explicitly
            const unavailableIndicators = [
                "no longer accepting applications",
                "job is closed",
                "this job is no longer available",
                "job expired",
                "posting removed",
                "this job posting is no longer active"
            ];
            const isUnavailable = unavailableIndicators.some(ind => lowerContent.includes(ind));
            if (isUnavailable) {
                logger.worker.warn(`[Intermediary Router] Job is no longer available on ${initialClassification}.`);
                return {
                    type: "JOB_UNAVAILABLE",
                    reason: "Job closed/unavailable",
                    routingHistory
                };
            }

            if (initialClassification === "LINKEDIN_JOB") {
                // Task 2: Advanced Apply Control Detection
                const easyApplyLocators = [
                    "button:has-text('Easy Apply')",
                    ".jobs-apply-button:has-text('Easy Apply')",
                    "button[data-is-easy-apply='true']",
                    "a[data-is-easy-apply='true']",
                    "[aria-label*='Easy Apply' i]"
                ];
                for (const sel of easyApplyLocators) {
                    const btn = page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                        logger.worker.info(`[Intermediary Router] Detected LinkedIn Easy Apply ("${sel}").`);
                        return {
                            type: "LINKEDIN_EASY_APPLY",
                            destinationUrl: currentUrl,
                            ats: "LINKEDIN_EASY_APPLY",
                            routingHistory
                        };
                    }
                }

                // Check for External Apply button
                const externalApplyLocators = [
                    "button.jobs-apply-button",
                    "a.jobs-apply-button",
                    "button:has-text('Apply')",
                    "a:has-text('Apply')",
                    "a[href*='apply']",
                    "a[data-tracking-control-name*='apply']",
                    "[aria-label*='Apply on company website' i]",
                    "button:has-text('Apply on company website')"
                ];

                for (const sel of externalApplyLocators) {
                    const btn = page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                        const btnText = await btn.innerText().catch(() => "Apply");

                        // If button asks for sign in to apply
                        if (btnText.toLowerCase().includes("sign in") || btnText.toLowerCase().includes("log in")) {
                            logger.worker.warn(`[Intermediary Router] Apply button requires LinkedIn sign-in.`);
                            return {
                                type: "LINKEDIN_AUTH_REQUIRED",
                                reason: "LinkedIn sign-in required to apply",
                                routingHistory
                            };
                        }

                        logger.worker.info(`[Intermediary Router] Found LinkedIn External Apply button ("${btnText.trim()}"). Capturing redirect...`);
                        let capturedUrl = null;

                        // Listen for popup page or same-tab navigation
                        const [popup] = await Promise.all([
                            page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
                            btn.click({ force: true }).catch(() => {})
                        ]);

                        if (popup) {
                            await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
                            await popup.waitForTimeout(3000);
                            capturedUrl = popup.url();
                            await popup.close().catch(() => {});
                        } else {
                            await page.waitForTimeout(4000);
                            capturedUrl = page.url();
                        }

                        // Check if clicked link returned an external URL (must not be LinkedIn or Indeed)
                        if (capturedUrl && !this.isLinkedInUrl(capturedUrl) && !this.isIndeedUrl(capturedUrl)) {
                            const finalAts = this.classifyATS(capturedUrl);
                            routingHistory.push({ type: "EXTERNAL_ATS", platform: finalAts, url: capturedUrl });
                            logger.worker.info(`[Intermediary Router] Resolved external destination URL: ${capturedUrl} (ATS: ${finalAts})`);
                            return {
                                type: "EXTERNAL_ATS",
                                destinationUrl: capturedUrl,
                                ats: finalAts,
                                applicationMethod: "LINKEDIN_EXTERNAL_APPLY",
                                routingStatus: "RESOLVED",
                                routingHistory
                            };
                        }
                    }
                }

                // Task 5: If public guest view hides Apply button but login is required to apply
                if (authState === "PUBLIC_GUEST") {
                    const signInPrompt = lowerContent.includes("sign in to apply") || lowerContent.includes("join to apply") || lowerContent.includes("sign in to view");
                    if (signInPrompt) {
                        logger.worker.warn(`[Intermediary Router] Public page requires LinkedIn authentication to view Apply control.`);
                        return {
                            type: "LINKEDIN_AUTH_REQUIRED",
                            reason: "LinkedIn login required to apply on guest view",
                            routingHistory
                        };
                    }
                }
            }

            // LOOP PROTECTION & VALIDATION: Destination is still LinkedIn
            if (this.isLinkedInUrl(page.url())) {
                logger.worker.warn(`[Intermediary Router] Destination remains LinkedIn (${page.url()}). Cannot classify as EXTERNAL_ATS.`);
                return {
                    type: "APPLICATION_URL_UNRESOLVED",
                    reason: "Destination URL remains LinkedIn",
                    routingHistory
                };
            }

            const finalAts = this.classifyATS(page.url());
            routingHistory.push({ type: "DESTINATION", platform: finalAts, url: page.url() });

            return {
                type: "EXTERNAL_ATS",
                destinationUrl: page.url(),
                ats: finalAts,
                routingHistory
            };

        } catch (err) {
            logger.worker.error(`[Intermediary Router] Error resolving ${initialUrl}: ${err.message}`);
            return {
                type: "APPLICATION_URL_UNRESOLVED",
                reason: err.message,
                routingHistory
            };
        }
    }

    /**
     * Route an external application, saving details to DB
     * @param {Object} job 
     * @param {string} externalUrl 
     * @returns {Promise<string>} The detected ATS type
     */
    async route(job, externalUrl) {
        const ats = this.classifyATS(externalUrl);
        logger.worker.info(`Detected ATS for external job: ${ats} (URL: ${externalUrl})`);
        
        await db.run(
            `UPDATE jobs 
             SET status = 'EXTERNAL_PENDING', 
                 external_url = ?, 
                 ats = ?, 
                 ignored = 0, 
                 reason = ? 
             WHERE id = ?`,
            [externalUrl, ats, `External ATS: ${ats}`, job.id]
        );
        
        return ats;
    }
}

module.exports = new ExternalApplicationRouter();
