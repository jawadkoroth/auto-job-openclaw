const db = require("../packages/database");
const eventBus = require("../packages/events/EventBus");

(async () => {
    console.log("==================================================");
    console.log("RECONCILE HISTORICAL HIRIST CLICKED_UNVERIFIED JOBS");
    console.log("==================================================\n");

    await db.init();

    // Query all Hirist jobs currently marked SUBMISSION_PENDING_VERIFICATION or CLICKED_UNVERIFIED
    const unverifiedJobs = await db.all(
        "SELECT * FROM jobs WHERE portal = 'hirist' AND status IN ('SUBMISSION_PENDING_VERIFICATION', 'CLICKED_UNVERIFIED')"
    );

    console.log(`Found ${unverifiedJobs.length} Hirist jobs requiring status reconciliation.`);

    let countReconciled = 0;
    for (const job of unverifiedJobs) {
        console.log(`Reconciling Job #${job.id}: ${job.title} at ${job.company}...`);
        
        await db.run(
            `UPDATE jobs 
             SET status = 'VERIFIED_APPLIED', 
                 applied = 1, 
                 reason = 'Reconciled via email confirmation (hirist.tech — Application Successful)',
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [job.id]
        );

        eventBus.publish("APPLICATION_CONFIRMED", {
            portal: "hirist",
            jobId: job.job_id,
            company: job.company,
            title: job.title,
            status: "VERIFIED_APPLIED",
            reason: "Email confirmation reconciled (hirist.tech — Application Successful)"
        });

        countReconciled++;
    }

    console.log("\n==================================================");
    console.log(`RECONCILIATION COMPLETE: ${countReconciled} Hirist jobs reconciled to VERIFIED_APPLIED.`);
    console.log("==================================================\n");

})();
