const candidateKnowledgeService = require("../../knowledge/CandidateKnowledgeService");
const externalApplicationRouter = require("../../router/ExternalApplicationRouter");
const externalAtsAutomation = require("../../automation/ExternalAtsAutomation");
const telegramService = require("../../../apps/telegram");
const db = require("../../database");

module.exports = async function apply(plugin, page, job) {
    const { logger, config } = plugin;
    const isDryRun = process.env.DRY_RUN === "true" || (config && config.search && config.search.dryRun === true);
    const allowLive = process.env.ALLOW_LIVE_APPLICATIONS === "true" || (config && config.search && config.search.allowLiveApplications === true);

    logger.info(`Processing Cutshort application for Job ID: ${job.job_id} ("${job.title}" at "${job.company}")`);
    logger.info(`Mode: DRY_RUN=${isDryRun}, ALLOW_LIVE_APPLICATIONS=${allowLive}`);

    try {
        // Step 1: Navigate to Job Details page
        logger.info(`Navigating to Cutshort job URL: ${job.url}`);
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(3000);

        // Step 2: Check for external ATS link or redirect
        const pageUrl = page.url();
        if (pageUrl && !pageUrl.includes("cutshort.io")) {
            logger.info(`Detected external redirect to: ${pageUrl}`);
            const atsName = externalApplicationRouter.classifyATS(pageUrl);
            await db.run("UPDATE jobs SET external_url = ?, ats = ?, application_method = 'EXTERNAL_ATS' WHERE portal = 'cutshort' AND job_id = ?", [pageUrl, atsName, job.job_id]);
            return await externalAtsAutomation.processExternalJob(page, { ...job, external_url: pageUrl, ats: atsName });
        }

        // Step 3: Locate Apply Button
        const applySelectors = [
            "button:has-text('Apply to this job')",
            "button:has-text('Apply')",
            "a:has-text('Apply')",
            "button:has-text('Interested')",
            "button:has-text('Easy Apply')",
            "[class*='apply-btn']",
            "[class*='Apply']"
        ];

        let applyBtn = null;
        for (const sel of applySelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
                applyBtn = loc;
                break;
            }
        }

        if (!applyBtn) {
            // Check if already applied
            const appliedIndicator = await page.locator("text=/applied/i, text=/already applied/i, button:disabled:has-text('Applied')").count().catch(() => 0);
            if (appliedIndicator > 0) {
                logger.info(`Job ${job.job_id} is already applied on Cutshort.`);
                await db.run("UPDATE jobs SET applied = 1, status = 'APPLIED', reason = 'ALREADY_APPLIED_ON_PORTAL' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
                return true;
            }

            logger.warn(`Apply button not found for Cutshort job ${job.job_id}`);
            await db.run("UPDATE jobs SET status = 'FAILED', reason = 'APPLY_BUTTON_NOT_FOUND' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
            return false;
        }

        // Check if button links directly to external ATS
        const btnHref = await applyBtn.getAttribute("href").catch(() => null);
        if (btnHref && !btnHref.includes("cutshort.io") && btnHref.startsWith("http")) {
            const atsName = externalApplicationRouter.classifyATS(btnHref);
            logger.info(`Apply button links externally to ATS: ${atsName} (${btnHref})`);
            await db.run("UPDATE jobs SET external_url = ?, ats = ?, application_method = 'EXTERNAL_ATS' WHERE portal = 'cutshort' AND job_id = ?", [btnHref, atsName, job.job_id]);
            return await externalAtsAutomation.processExternalJob(page, { ...job, external_url: btnHref, ats: atsName });
        }

        // Click Apply Button
        logger.info("Clicking Cutshort Apply button...");
        await applyBtn.click().catch(() => {});
        await page.waitForTimeout(3000);

        // Step 4: Check if Login Modal / Authentication requested
        const authModal = await page.locator("text=/Sign in/i, text=/Log in/i, input[type='email']").count().catch(() => 0);
        if (authModal > 0 && !(await plugin.health(page))) {
            logger.warn(`Cutshort requires authentication for job ${job.job_id}. Attempting login...`);
            const loggedIn = await plugin.login(page);
            if (!loggedIn) {
                logger.error("Cutshort authentication required but login failed or session expired.");
                await db.run("UPDATE jobs SET status = 'FAILED', reason = 'AUTH_REQUIRED' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
                return false;
            }
            // Retry navigation and click apply after login
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(2000);
            const retryBtn = page.locator("button:has-text('Apply')").first();
            if (await retryBtn.isVisible().catch(() => false)) {
                await retryBtn.click().catch(() => {});
                await page.waitForTimeout(3000);
            }
        }

        // Step 5: Check Application Drawer / Modal Form / Questions
        logger.info("Inspecting Cutshort application form / questions...");
        
        // Handle Cover Letter / Note to recruiter if present
        const noteTextarea = page.locator("textarea[placeholder*='note' i], textarea[placeholder*='cover' i], textarea[placeholder*='why' i], textarea").first();
        if (await noteTextarea.isVisible().catch(() => false)) {
            const coverLetter = await candidateKnowledgeService.getCoverLetter({ company: job.company, role: job.title });
            if (coverLetter) {
                logger.info("Autofilling cover letter note in Cutshort form...");
                await noteTextarea.fill(coverLetter.slice(0, 500));
            }
        }

        // Upload Resume / Default CV if requested
        const fileInput = page.locator("input[type='file']").first();
        if (await fileInput.isVisible().catch(() => false)) {
            const resumePath = await candidateKnowledgeService.getResumePath("default");
            if (resumePath) {
                logger.info(`Uploading default CV: ${resumePath}`);
                await fileInput.setInputFiles(resumePath).catch(err => logger.warn(`CV upload error: ${err.message}`));
            }
        }

        // Handle Application Questions
        const questionInputs = page.locator("label, div[class*='question'], [class*='FormGroup']");
        const qCount = await questionInputs.count().catch(() => 0);

        for (let i = 0; i < qCount; i++) {
            const qEl = questionInputs.nth(i);
            const qText = await qEl.innerText().catch(() => "");
            if (!qText || qText.length < 5) continue;

            const res = await candidateKnowledgeService.resolveQuestion({ question: qText, jobId: job.job_id });
            if (res.status === "WAITING_FOR_INPUT") {
                logger.warn(`Unresolved question encountered on Cutshort: "${qText}". Status -> WAITING_FOR_INPUT`);
                await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT', pending_question = ? WHERE portal = 'cutshort' AND job_id = ?", [qText, job.job_id]);

                await telegramService.sendQuestionPrompt({
                    jobId: job.job_id,
                    company: job.company,
                    title: job.title,
                    question: qText,
                    portal: "cutshort"
                }).catch(e => logger.error(`Telegram prompt failed: ${e.message}`));

                return false;
            }
        }

        // Step 6: Final Submission vs DRY RUN
        const submitBtnSelectors = [
            "button:has-text('Submit')",
            "button:has-text('Send')",
            "button:has-text('Submit Application')",
            "button:has-text('Confirm')",
            "button[type='submit']"
        ];

        let finalSubmitBtn = null;
        for (const sSel of submitBtnSelectors) {
            const btnLoc = page.locator(sSel).first();
            if (await btnLoc.isVisible().catch(() => false)) {
                finalSubmitBtn = btnLoc;
                break;
            }
        }

        if (isDryRun || !allowLive) {
            logger.info(`DRY_RUN active. All fields & CV processed for Cutshort job ${job.job_id}. NOT clicking submit.`);
            await db.run("UPDATE jobs SET status = 'DRY_RUN_PASSED', application_method = 'NATIVE' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
            return true;
        }

        // LIVE SUBMISSION
        if (finalSubmitBtn) {
            logger.info("Executing LIVE submission on Cutshort...");
            await finalSubmitBtn.click();
            await page.waitForTimeout(4000);

            const confirmMsg = await page.locator("text=/submitted/i, text=/success/i, text=/applied/i, [class*='success']").count().catch(() => 0);
            if (confirmMsg > 0) {
                logger.info(`✅ Submission confirmed for Cutshort job ${job.job_id}`);
                await db.run("UPDATE jobs SET applied = 1, status = 'APPLIED', application_method = 'NATIVE' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
                return true;
            } else {
                logger.warn(`Submission clicked but confirmation unobserved for Cutshort job ${job.job_id}. Marking CLICKED_UNVERIFIED.`);
                await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED', application_method = 'NATIVE' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
                return true;
            }
        } else {
            logger.info("Cutshort application completed upon primary click.");
            await db.run("UPDATE jobs SET applied = 1, status = 'APPLIED', application_method = 'NATIVE' WHERE portal = 'cutshort' AND job_id = ?", [job.job_id]);
            return true;
        }

    } catch (err) {
        logger.error(`Error during Cutshort application: ${err.message}`);
        await db.run("UPDATE jobs SET status = 'FAILED', reason = ? WHERE portal = 'cutshort' AND job_id = ?", [err.message, job.job_id]).catch(() => {});
        return false;
    }
};
