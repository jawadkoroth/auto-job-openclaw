const logger = require("../logger").plugin("naukri");
const eventBus = require("../events/EventBus");
const db = require("../database");
const oraclePersistence = require("../persistence/NaukriOraclePersistence");
const candidateKnowledgeService = require("../knowledge/CandidateKnowledgeService");
const externalRedirectResolver = require("./ExternalRedirectResolver");
const atsClassifier = require("./ATSClassifier");
const externalApplicationRouter = require("./ExternalApplicationRouter");
const questionnaireEngine = require("./QuestionnaireEngine");
const telegramService = require("../../apps/telegram");

class ExternalApplicationEngine {
    /**
     * Process an external job application with full multi-channel handoff resolution & hard domain safety.
     * @param {Object} params
     * @param {import('playwright').Page} params.naukriPage
     * @param {import('playwright').BrowserContext} params.context
     * @param {Object} params.job
     * @param {Object} params.candidateProfile
     * @param {boolean} [params.isDryRun=false]
     * @returns {Promise<{ status: string, applied: number, ats: string, externalUrl?: string, reason?: string }>}
     */
    async processExternalJob({ naukriPage, context, job, candidateProfile, isDryRun = false }) {
        logger.info(`\n==================================================`);
        logger.info(`[ExternalApplicationEngine] Processing Job ID: ${job.id} | ${job.title} at ${job.company}`);
        logger.info(`==================================================`);

        try {
            // 1. Multi-Channel External Redirect Resolution
            const applyBtnLocators = [
                naukriPage.locator("button:has-text('Apply on company site')"),
                naukriPage.locator("a:has-text('Apply on company site')"),
                naukriPage.locator("[class*='apply']:has-text('company site')"),
                naukriPage.locator("button.apply-button"),
                naukriPage.locator("button:has-text('Apply')")
            ];

            let applyBtn = null;
            for (const loc of applyBtnLocators) {
                if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                    applyBtn = loc.first();
                    break;
                }
            }

            if (!applyBtn) {
                logger.warn(`[ExternalEngine] Could not locate apply button for Job ID ${job.id}`);
                await oraclePersistence.updateJobStatus(job.id, 'APPLY_BUTTON_NOT_FOUND');
                return { status: 'APPLY_BUTTON_NOT_FOUND', applied: 0, ats: 'UNKNOWN' };
            }

            const resolution = await externalRedirectResolver.resolveExternalDestination({
                page: naukriPage,
                context,
                applyBtn
            });

            // Hard Domain Safety Guard: Must be genuine external domain
            if (!resolution.resolved || !resolution.isExternalDomain || !resolution.destinationUrl) {
                logger.warn(`⚠️ [ExternalEngine] Safety Invariant Triggered: Target URL is not external (${resolution.destinationUrl || 'None'}). Aborting.`);
                await oraclePersistence.updateJobStatus(job.id, 'EXTERNAL_HANDOFF_UNRESOLVED');
                await db.run(
                    "UPDATE jobs SET status = 'EXTERNAL_HANDOFF_UNRESOLVED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?",
                    [job.id]
                ).catch(() => {});
                return { status: 'EXTERNAL_HANDOFF_UNRESOLVED', applied: 0, ats: 'NAUKRI_INTERNAL', externalUrl: resolution.destinationUrl };
            }

            const externalUrl = resolution.destinationUrl;
            const externalPage = resolution.pageInstance;
            const isPopupCreated = resolution.isPopupCreated;

            logger.info(`✓ [ExternalEngine] External Destination Confirmed: ${externalUrl} (Domain: ${resolution.destinationDomain}, Method: ${resolution.method})`);

            // 2. ATS Classification (Enforces Hard Domain Invariant)
            const classification = await atsClassifier.classify(externalPage, externalUrl);
            logger.info(`[ExternalEngine] Classified ATS: ${classification.ats} (Confidence: ${classification.confidence}, Domain: ${classification.domain})`);

            if (!classification.isExternalDomain) {
                logger.warn(`⚠️ [ExternalEngine] ATSClassifier detected internal Naukri domain. Aborting external routing.`);
                await oraclePersistence.updateJobStatus(job.id, 'EXTERNAL_HANDOFF_UNRESOLVED');
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EXTERNAL_HANDOFF_UNRESOLVED', applied: 0, ats: 'NAUKRI_INTERNAL', externalUrl };
            }

            // Persist discovery of external redirect details into Oracle & DB
            const extPayload = {
                sourcePortal: "Naukri",
                applicationPortal: classification.ats,
                ats: classification.ats,
                originalUrl: job.url,
                externalUrl,
                company: job.company,
                role: job.title,
                job_id: job.id,
                handoffMethod: resolution.method
            };

            await oraclePersistence.recordJob({
                ...job,
                url: externalUrl,
                ats: classification.ats,
                applicationPortal: classification.ats
            }).catch(() => {});

            await db.run(
                "UPDATE jobs SET url = ?, status = 'EXTERNAL_REDIRECTED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?",
                [externalUrl, job.id]
            ).catch(() => {});

            if (isDryRun) {
                logger.info(`[ExternalEngine] DRY RUN mode active. External redirect confirmed & ATS classified as ${classification.ats}. Aborting submission.`);
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EXTERNAL_REQUIRED', applied: 0, ats: classification.ats, externalUrl };
            }

            // 3. Select Adapter & Check Auth/MFA/Captcha Security Constraints
            const adapter = externalApplicationRouter.getAdapter(classification.ats);
            const authCheck = await adapter.detectAuthOrCaptcha(externalPage);

            if (authCheck.blocked) {
                const blockedStatus = authCheck.reason || 'AUTH_REQUIRED';
                logger.warn(`⚠️ [ExternalEngine] Application halted on ${classification.ats}: ${blockedStatus} (${authCheck.details})`);

                await oraclePersistence.updateJobStatus(job.id, blockedStatus);
                await db.run("UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [blockedStatus, job.id]).catch(() => {});

                await telegramService.sendExternalActionRequiredNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: blockedStatus,
                    reason: authCheck.details,
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram notification error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: blockedStatus, applied: 0, ats: classification.ats, externalUrl, reason: authCheck.details };
            }

            // 4. Attach Candidate Resume
            const resumePath = await candidateKnowledgeService.getResumePath().catch(() => null);
            let resumeAttached = false;
            if (resumePath) {
                const uploadRes = await adapter.uploadResume(externalPage, resumePath);
                resumeAttached = uploadRes.attached;
            }

            // 5. Questionnaire Engine & Form Safety Evaluation
            const fillResult = await adapter.fillForm(externalPage, candidateProfile, questionnaireEngine);

            if (!fillResult.success || fillResult.status !== "FORM_READY") {
                const failureStatus = fillResult.status || 'SUBMIT_FAILED';
                const failureReason = fillResult.details || fillResult.reasonCode || (fillResult.unresolvedRequired?.[0]?.label ? `Unresolved required field: "${fillResult.unresolvedRequired[0].label}"` : "Pre-submission safety check failed");

                logger.warn(`⚠️ [ExternalEngine] Application halted on ${classification.ats}: ${failureStatus} (${failureReason})`);

                await oraclePersistence.updateJobStatus(job.id, failureStatus);
                await db.run("UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [failureStatus, job.id]).catch(() => {});

                await telegramService.sendExternalActionRequiredNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: failureStatus,
                    reason: failureReason,
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram notification error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: failureStatus, applied: 0, ats: classification.ats, externalUrl, reason: failureReason };
            }

            // 6. Submit Application ONLY IF FORM_READY
            logger.info(`[ExternalEngine] Executing Submit on ${classification.ats}...`);
            const submitClicked = await adapter.submit(externalPage);
            if (!submitClicked) {
                logger.warn(`[ExternalEngine] Submit action button could not be clicked on ${classification.ats}.`);
                await oraclePersistence.updateJobStatus(job.id, 'SUBMIT_FAILED');
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'SUBMIT_FAILED', applied: 0, ats: classification.ats, externalUrl, reason: "Submit action button click failed" };
            }

            // 7. Layered Independent Submission Verification
            const verifyResult = await adapter.verifySubmission(externalPage);

            if (verifyResult.verified) {
                logger.info(`✓ [ExternalEngine] VERIFIED EXTERNAL APPLICATION SUBMITTED! (${classification.ats})`);
                await oraclePersistence.updateJobStatus(job.id, 'EMPLOYER_PENDING', 1);
                await oraclePersistence.recordEvent(`evt_${Date.now()}_${job.id}`, job.id, 'naukri', 'EXTERNAL_APPLICATION_SUBMITTED', extPayload);
                await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});
                eventBus.publish("APPLICATION_SUBMITTED", { portal: "Naukri", ats: classification.ats, jobId: job.id, title: job.title, company: job.company });

                await telegramService.sendExternalApplicationSubmittedNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: "EMPLOYER_PENDING",
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram send error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EMPLOYER_PENDING', applied: 1, ats: classification.ats, externalUrl };
            } else {
                logger.warn(`⚠️ [ExternalEngine] Submit clicked but verification inconclusive on ${classification.ats}. Marking CLICKED_UNVERIFIED.`);
                await oraclePersistence.updateJobStatus(job.id, 'CLICKED_UNVERIFIED', 0);
                await db.run("UPDATE jobs SET applied = 0, status = 'CLICKED_UNVERIFIED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'CLICKED_UNVERIFIED', applied: 0, ats: classification.ats, externalUrl, reason: verifyResult.details };
            }

        } catch (err) {
            logger.error(`❌ [ExternalEngine] Exception while processing Job ID ${job.id}: ${err.message}`, err.stack);
            await oraclePersistence.updateJobStatus(job.id, 'SUBMIT_FAILED');
            return { status: 'SUBMIT_FAILED', applied: 0, ats: 'UNKNOWN', reason: err.message };
        }
    }
}

module.exports = new ExternalApplicationEngine();
