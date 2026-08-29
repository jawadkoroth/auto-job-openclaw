const path = require('path');
const db = require('../packages/database');
const workerRegistry = require('../packages/worker/WorkerRegistry');

async function audit() {
    await db.init();
    const waitingJobs = await db.all("SELECT * FROM jobs WHERE status = 'WAITING_FOR_INPUT' ORDER BY id ASC");
    const waitingTasks = await db.all("SELECT * FROM tasks WHERE status = 'WAITING_FOR_INPUT' ORDER BY id ASC");
    const allJobs = await db.all("SELECT status, count(*) as count FROM jobs GROUP BY status");
    const allTasks = await db.all("SELECT status, count(*) as count FROM tasks GROUP BY status");

    console.log("=== JOBS STATUS BREAKDOWN ===");
    console.log(JSON.stringify(allJobs, null, 2));
    console.log("=== TASKS STATUS BREAKDOWN ===");
    console.log(JSON.stringify(allTasks, null, 2));

    console.log("\n=== WAITING_FOR_INPUT JOBS (" + waitingJobs.length + ") ===");
    for (const j of waitingJobs) {
        console.log({
            id: j.id,
            portal: j.portal,
            job_id: j.job_id,
            company: j.company,
            title: j.title,
            pending_question: j.pending_question,
            pending_question_id: j.pending_question_id,
            status: j.status,
            timestamp: j.timestamp,
            updated_at: j.updated_at
        });
    }

    console.log("\n=== WAITING_FOR_INPUT TASKS (" + waitingTasks.length + ") ===");
    for (const t of waitingTasks) {
        console.log({
            id: t.id,
            portal: t.portal,
            action: t.action,
            status: t.status,
            created_at: t.created_at,
            updated_at: t.updated_at
        });
    }

    process.exit(0);
}

audit().catch(err => {
    console.error(err);
    process.exit(1);
});
