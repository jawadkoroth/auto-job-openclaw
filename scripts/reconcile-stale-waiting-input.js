const db = require("../packages/database");

async function reconcileStaleWaitingInput() {
    console.log("=================================================");
    console.log(" Reconciling Stale WAITING_FOR_INPUT Records     ");
    console.log("=================================================\n");

    await db.init();

    const staleJobs = await db.all(
        "SELECT * FROM jobs WHERE status = 'WAITING_FOR_INPUT' ORDER BY id ASC"
    );

    const staleTasks = await db.all(
        "SELECT * FROM tasks WHERE status = 'WAITING_FOR_INPUT' ORDER BY id ASC"
    );

    console.log(`Found ${staleJobs.length} WAITING_FOR_INPUT jobs and ${staleTasks.length} WAITING_FOR_INPUT tasks.\n`);

    if (staleJobs.length > 0) {
        console.log("Auditing & Transitioning Jobs -> CANCELLED:");
        for (const job of staleJobs) {
            console.log(` • [Job #${job.id}] ${job.portal.toUpperCase()} | ${job.company || 'Unknown'} - ${job.title || 'Unknown'} (Created: ${job.timestamp}, Updated: ${job.updated_at || 'N/A'}) -> STALE / CANCELLED`);
        }

        const resJobs = await db.run(
            "UPDATE jobs SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE status = 'WAITING_FOR_INPUT'"
        );
        console.log(`\n✓ Successfully transitioned ${resJobs.changes} stale jobs to CANCELLED.`);
    }

    if (staleTasks.length > 0) {
        const resTasks = await db.run(
            "UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE status = 'WAITING_FOR_INPUT'"
        );
        console.log(`✓ Successfully transitioned ${resTasks.changes} stale tasks to cancelled.`);
    }

    // Verify final database state
    const remainingWaiting = await db.all("SELECT id, status FROM jobs WHERE status = 'WAITING_FOR_INPUT'");
    console.log(`\nFinal Active WAITING_FOR_INPUT Jobs Count: ${remainingWaiting.length}`);
    console.log("Database history preserved without data loss.\n");
}

reconcileStaleWaitingInput().catch(err => {
    console.error("Reconciliation failed:", err);
    process.exit(1);
});
