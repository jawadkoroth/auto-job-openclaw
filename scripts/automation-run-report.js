#!/usr/bin/env node
/**
 * Automation Run Report CLI
 * Produces concise human-readable summaries for automation runs.
 *
 * Usage:
 *   node scripts/automation-run-report.js --today
 *   node scripts/automation-run-report.js --portal naukri
 *   node scripts/automation-run-report.js --run-id <run_id>
 *   node scripts/automation-run-report.js --date 2026-08-29
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const { storage } = require("../packages/observability");

function parseArgs() {
    const args = process.argv.slice(2);
    const isToday = args.includes("--today");
    const dateIdx = args.indexOf("--date");
    const date = dateIdx !== -1 ? args[dateIdx + 1] : (isToday ? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : null);
    
    const portalIdx = args.indexOf("--portal");
    const portal = portalIdx !== -1 ? args[portalIdx + 1] : null;

    const runIdIdx = args.indexOf("--run-id");
    const runId = runIdIdx !== -1 ? args[runIdIdx + 1] : null;

    const isVerbose = args.includes("--verbose");
    const isJson = args.includes("--json");

    return { isToday, date, portal, runId, isVerbose, isJson };
}

(async () => {
    try {
        await db.init();
        const options = parseArgs();

        if (options.runId) {
            const details = await storage.getRunDetails(options.runId);
            if (!details || !details.run) {
                console.error(`❌ Run not found: ${options.runId}`);
                process.exit(1);
            }

            const r = details.run;
            console.log("==================================================");
            console.log(`📋 AUTOMATION RUN REPORT: ${r.run_id}`);
            console.log("==================================================");
            console.log(`• Portal:        ${r.portal.toUpperCase()}`);
            console.log(`• Worker:        ${r.worker_id}`);
            console.log(`• Trigger:       ${r.trigger_type}`);
            console.log(`• Status:        ${r.status}`);
            console.log(`• Started:       ${r.started_at}`);
            console.log(`• Finished:      ${r.finished_at || 'In progress'}`);
            console.log(`• Duration:      ${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : 'N/A'}`);
            console.log("\nMetrics:");
            console.log(`  Discovered:    ${r.discovered_count}`);
            console.log(`  Selected:      ${r.selected_count}`);
            console.log(`  Attempts:      ${r.attempts_count}`);
            console.log(`  ✅ Verified:   ${r.verified_applied_count}`);
            console.log(`  ⏳ Pending:    ${r.pending_verification_count}`);
            console.log(`  ⚠️ Waiting:    ${r.waiting_input_count}`);
            console.log(`  ❌ Failed:     ${r.failed_count}`);

            if (r.zero_reason) {
                console.log(`\n⚠️ Zero Applied Reason: ${r.zero_reason}`);
            }

            if (details.attempts.length > 0) {
                console.log("\nIndividual Application Attempts:");
                console.log("-".repeat(50));
                for (const att of details.attempts) {
                    console.log(`• [${att.verdict}] Job ${att.job_id} | ${att.title} at ${att.company}`);
                    if (att.error_message) {
                        console.log(`    Error: ${att.error_message}`);
                    }
                }
            }
            console.log("==================================================");
            process.exit(0);
        }

        const targetDate = options.date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const summary = await storage.getDailySummary(targetDate);

        if (options.isJson) {
            console.log(JSON.stringify(summary, null, 2));
            process.exit(0);
        }

        console.log("==================================================");
        console.log(`📊 DAILY AUTOMATION RUN REPORT [${targetDate}]`);
        console.log("==================================================");
        console.log(`• Total Runs:           ${summary.totalRuns}`);
        console.log(`• Total Discovered:     ${summary.discovered}`);
        console.log(`• Total Selected:       ${summary.selected}`);
        console.log(`• Total Attempts:       ${summary.attempts}`);
        console.log(`• ✅ Verified Applied:   ${summary.verifiedApplied}`);
        console.log(`• ⏳ Pending Confirm:    ${summary.pendingVerification}`);
        console.log(`• ❌ Failed:            ${summary.failed}`);
        console.log(`• 🎯 Real Success Rate: ${summary.successRate}%\n`);

        console.log("Portal Breakdown:");
        console.log("--------------------------------------------------");
        for (const [p, stats] of Object.entries(summary.portalStats)) {
            if (options.portal && options.portal.toLowerCase() !== p.toLowerCase()) continue;
            const rate = stats.attempts > 0 ? ((stats.verified / stats.attempts) * 100).toFixed(1) : "0.0";
            console.log(`• ${p.toUpperCase().padEnd(12)}: Runs=${stats.runs}, Att=${stats.attempts}, Verif=${stats.verified}, Fail=${stats.failed} (Rate: ${rate}%)`);
            if (stats.zeroReasons.length > 0) {
                console.log(`   Reasons: ${[...new Set(stats.zeroReasons)].join(", ")}`);
            }
        }

        if (summary.runs.length > 0) {
            console.log("\nRuns Log:");
            console.log("--------------------------------------------------");
            for (const r of summary.runs) {
                if (options.portal && options.portal.toLowerCase() !== r.portal.toLowerCase()) continue;
                const statusBadge = r.status === "COMPLETED" ? "✅" : (r.status === "RUNNING" ? "⏳" : "❌");
                console.log(`${statusBadge} [${r.portal.toUpperCase()}] ${r.run_id} | ${r.worker_id} | Verif: ${r.verified_applied_count}/${r.attempts_count}`);
            }
        }
        console.log("==================================================");
        process.exit(0);

    } catch (err) {
        console.error(`Report execution error: ${err.message}`);
        process.exit(1);
    }
})();
