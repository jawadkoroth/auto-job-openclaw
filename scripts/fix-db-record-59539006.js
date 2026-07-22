const db = require("../packages/database");

async function fixRecord() {
    await db.init();
    
    console.log("Fixing DB record for Foundit Job ID 59539006...");
    
    const targetUrl = "https://job-boards.greenhouse.io/togetherai/jobs/5180155007?gh_src=fbe3b70a7us";
    const intermediaryUrl = "https://www.linkedin.com/jobs/view/4439452616/";
    
    const existing = await db.get("SELECT * FROM jobs WHERE portal = 'foundit' AND (job_id = '59539006' OR id = 872)");
    
    if (existing) {
        await db.run(
            `UPDATE jobs 
             SET company = 'Together AI',
                 ats = 'Greenhouse',
                 external_url = ?,
                 final_application_url = ?,
                 intermediary_platform = 'linkedin',
                 intermediary_url = ?,
                 application_method = 'LINKEDIN_EXTERNAL_APPLY',
                 routing_status = 'RESOLVED',
                 status = 'EXTERNAL_PENDING',
                 applied = 0,
                 reason = 'External ATS: Greenhouse (Resolved from LinkedIn Intermediary)'
             WHERE id = ?`,
            [targetUrl, targetUrl, intermediaryUrl, existing.id]
        );
        console.log(`✅ Updated existing job record (ID ${existing.id}).`);
    } else {
        await db.run(
            `INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, external_url, final_application_url, intermediary_platform, intermediary_url, application_method, routing_status, ats, status, applied)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "foundit",
                "59539006",
                "Together AI",
                "DevOps / Infrastructure Engineer",
                "Remote / USA / India",
                "3-6 Yrs",
                "Not Disclosed",
                "https://www.foundit.in/job-detail/59539006",
                targetUrl,
                targetUrl,
                "linkedin",
                intermediaryUrl,
                "LINKEDIN_EXTERNAL_APPLY",
                "RESOLVED",
                "Greenhouse",
                "EXTERNAL_PENDING",
                0
            ]
        );
        console.log("✅ Created new job record for 59539006.");
    }
    
    const updated = await db.get("SELECT * FROM jobs WHERE portal = 'foundit' AND (job_id = '59539006' OR id = 872)");
    console.log("Updated Record:\n", JSON.stringify(updated, null, 2));
}

fixRecord().catch(err => {
    console.error("Error fixing record:", err);
    process.exit(1);
});
