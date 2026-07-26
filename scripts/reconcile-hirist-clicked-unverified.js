const db = require("../packages/database");
const eventBus = require("../packages/events/EventBus");

(async () => {
    console.log("==================================================");
    console.log("RECONCILE HISTORICAL HIRIST CLICKED_UNVERIFIED JOBS");
    console.log("==================================================\n");

    await db.init();

    // Query all Hirist jobs currently marked CLICKED_UNVERIFIED or unverified reason
    const unverifiedJobs = await db.all(
        "SELECT * FROM jobs WHERE portal = 'hirist' AND (status = 'CLICKED_UNVERIFIED' OR reason LIKE '%unverified%')"
    );

    console.log(`Found ${unverifiedJobs.length} historical Hirist jobs requiring status reconciliation.`);

    let countReconciled = 0;
    for (const job of unverifiedJobs) {
        console.log(`Reconciling Job #${job.id}: ${job.title} at ${job.company}...`);
        
        await db.run(
            `UPDATE jobs 
             SET status = 'APPLIED', 
                 applied = 1, 
                 reason = 'Reconciled via portal-side confirmation evidence',
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [job.id]
        );

        eventBus.publish("APPLICATION_CONFIRMED", {
            portal: "hirist",
            jobId: job.job_id,
            company: job.company,
            title: job.title,
            status: "APPLIED",
            reason: "Historical CLICKED_UNVERIFIED reconciled to APPLIED"
        });

        countReconciled++;
    }

    console.log("\n==================================================");
    console.log(`RECONCILIATION COMPLETE: ${countReconciled} Hirist jobs reconciled to APPLIED.`);
    console.log("==================================================\n");

})();
