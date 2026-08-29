#!/usr/bin/env node
/**
 * Automation Diagnostics CLI
 * Displays today's runs, jobs discovered/selected, application verdicts,
 * per-portal success rates, worker node health, and recent error telemetry.
 *
 * Usage:
 *   node scripts/automation-diagnostics.js
 *   node scripts/automation-diagnostics.js --date 2026-08-29
 *   node scripts/automation-diagnostics.js --json
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../packages/database");
const { storage } = require("../packages/observability");

function parseArgs() {
    const args = process.argv.slice(2);
    const dateIdx = args.indexOf("--date");
    const date = dateIdx !== -1 ? args[dateIdx + 1] : null;
    const isJson = args.includes("--json");
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;
    return { date, isJson, limit };
}

(async () => {
    try {
        await db.init();
        const { date, isJson, limit } = parseArgs();
        const targetDate = date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

        const daily = await storage.getDailySummary(targetDate);
        const workers = await storage.getWorkerHealth();
        const successRates = await storage.getPortalSuccessRates(targetDate);
        const recentErrors = await storage.getRecentErrors(limit);

        if (isJson) {
            console.log(JSON.stringify({
                daily,
                workers,
                successRates,
                recentErrors
            }, null, 2));
            process.exit(0);
        }

        console.log("================================================================================");
        console.log(`📊 OPENCLAW AUTOMATION OBSERVABILITY & DIAGNOSTICS [${targetDate}]`);
        console.log("================================================================================\n");

        // 1. Executive Summary
        console.log("🔹 1. EXECUTIVE METRICS & VERDICT SUMMARY");
        console.log("--------------------------------------------------------------------------------");
        console.log(`• Total Automation Runs:       ${daily.totalRuns}`);
        console.log(`• Jobs Discovered:             ${daily.discovered}`);
        console.log(`• Candidate Jobs Selected:     ${daily.selected}`);
        console.log(`• Total Applications Attempted:${daily.attempts}`);
        console.log(`• ✅ Verified Applied:          ${daily.verifiedApplied}`);
        console.log(`• ⏳ Pending Verification:      ${daily.pendingVerification}`);
        console.log(`• ⚠️ Waiting For Input:         ${daily.waitingForInput}`);
        console.log(`• ❌ Application Failures:      ${daily.failed}`);
        console.log(`• 🎯 REAL VERIFIED RATE:       ${daily.successRate}%`);
        console.log("");

        // 2. Per-Portal Success Rates
        console.log("🔹 2. PER-PORTAL PERFORMANCE & TRUTH MATRIX");
        console.log("--------------------------------------------------------------------------------");
        if (successRates.length === 0) {
            console.log("  (No runs recorded for this date)");
        } else {
            console.log(
                "Portal".padEnd(14) +
                "Runs".padStart(6) +
                "Discov".padStart(8) +
                "Select".padStart(8) +
                "Att".padStart(6) +
                "Verif".padStart(8) +
                "Pend".padStart(7) +
                "Fail".padStart(7) +
                "Success Rate".padStart(14)
            );
            console.log("-".repeat(78));
            for (const p of successRates) {
                console.log(
                    p.portal.toUpperCase().padEnd(14) +
                    String(p.runs).padStart(6) +
                    String(p.discovered).padStart(8) +
                    String(p.selected).padStart(8) +
                    String(p.attempts).padStart(6) +
                    String(p.verified).padStart(8) +
                    String(p.pending).padStart(7) +
                    String(p.failed).padStart(7) +
                    p.successRate.padStart(14)
                );
            }
        }
        console.log("");

        // 3. Worker Node Health
        console.log("🔹 3. WORKER NODE CLUSTER HEALTH");
        console.log("--------------------------------------------------------------------------------");
        for (const w of workers) {
            const statusIcon = w.status === "online" ? "🟢" : (w.status === "busy" ? "🟡" : "🔴");
            const lastSeenStr = w.lastSeen ? new Date(w.lastSeen).toLocaleTimeString() : "Never";
            console.log(
                `• ${statusIcon} [${w.id.toUpperCase().padEnd(8)}] Status: ${w.status.padEnd(8)} ` +
                `Host: ${(w.hostname || "unknown").padEnd(16)} ` +
                `Last Heartbeat: ${lastSeenStr.padEnd(10)} ` +
                `Active Task: ${w.currentTaskId || "None"}`
            );
        }
        console.log("");

        // 4. Today's Individual Runs
        console.log("🔹 4. TODAY'S AUTOMATION RUNS");
        console.log("--------------------------------------------------------------------------------");
        if (daily.runs.length === 0) {
            console.log("  (No runs recorded today)");
        } else {
            for (const r of daily.runs) {
                const durationSec = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "running";
                const statusBadge = r.status === "COMPLETED" ? "✅" : (r.status === "RUNNING" ? "⏳" : "❌");
                console.log(
                    `• ${statusBadge} [${r.run_id}] | Portal: ${r.portal.toUpperCase()} | Worker: ${r.worker_id} | ` +
                    `Trigger: ${r.trigger_type} | Duration: ${durationSec} | ` +
                    `Discov: ${r.discovered_count} | Sel: ${r.selected_count} | Att: ${r.attempts_count} | Verif: ${r.verified_applied_count}`
                );
                if (r.zero_reason) {
                    console.log(`    ⚠️ Zero Applied Reason: ${r.zero_reason}`);
                }
            }
        }
        console.log("");

        // 5. Recent Errors & Rejections
        console.log("🔹 5. RECENT FAILURE SIGNALS & DIAGNOSTIC ERRORS");
        console.log("--------------------------------------------------------------------------------");
        if (recentErrors.length === 0) {
            console.log("  (No errors or zero-application failures recorded)");
        } else {
            for (const err of recentErrors) {
                const timeStr = new Date(err.started_at).toLocaleTimeString();
                if (err.type === "RUN_FAILURE") {
                    console.log(`• [${timeStr}] Run ${err.run_id} (${err.portal}): ${err.error}`);
                } else {
                    console.log(`• [${timeStr}] Attempt ${err.attempt_id} (${err.portal} - Job ${err.job_id} at ${err.company}): ${err.error}`);
                }
            }
        }
        console.log("\n================================================================================");
        process.exit(0);

    } catch (err) {
        console.error(`Diagnostic execution error: ${err.message}`);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
})();
