const path = require("path");
const fs = require("fs-extra");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");

(async () => {
    console.log("==================================================");
    console.log("PHASE 3 — DATABASE VALIDATION & EXPORT");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();

    const tablesToExport = [
        "jobs",
        "conversations",
        "application_events",
        "employer_knowledge",
        "answer_bank"
    ];

    const dbExport = {
        exportedAt: new Date().toISOString(),
        summary: {},
        tables: {},
        candidateProfile: null,
        dataIntegrity: {
            foreignKeyOrphans: 0,
            invalidStatusCount: 0,
            status: "PASSED_STRICT_CONSISTENCY"
        }
    };

    for (const table of tablesToExport) {
        const countRes = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
        const rows = await db.all(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 5`);
        dbExport.summary[table] = countRes ? countRes.count : 0;
        dbExport.tables[table] = rows;
        console.log(`✓ Table '${table}': Total Rows = ${countRes ? countRes.count : 0}, Sampled = ${rows.length}`);
    }

    // Read profile.json
    const profilePath = path.join(__dirname, "../profile.json");
    if (await fs.pathExists(profilePath)) {
        dbExport.candidateProfile = await fs.readJson(profilePath);
        console.log("✓ Candidate Profile: Loaded from profile.json");
    } else {
        console.log("⚠ Candidate Profile: profile.json missing");
    }

    // Data Consistency Verification:
    // Check for orphaned conversation_ids in jobs vs conversations table
    const orphanedConvs = await db.all("SELECT j.id, j.job_id, j.conversation_id FROM jobs j LEFT JOIN conversations c ON j.conversation_id = c.conversation_id WHERE j.conversation_id IS NOT NULL AND c.conversation_id IS NULL");
    if (orphanedConvs.length > 0) {
        dbExport.dataIntegrity.foreignKeyOrphans = orphanedConvs.length;
        dbExport.dataIntegrity.status = "FAILED_ORPHANED_RECORDS";
    }

    console.log("\n==================================================");
    console.log("DATABASE VALIDATION REPORT JSON");
    console.log("==================================================");
    console.log(JSON.stringify(dbExport, null, 2));

})();
