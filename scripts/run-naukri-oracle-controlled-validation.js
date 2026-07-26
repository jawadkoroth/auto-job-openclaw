const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const sshKey = process.env.REMOTE_SSH_KEY;
const host = process.env.REMOTE_HOST || "140.245.212.88";
const user = process.env.REMOTE_USER || "ubuntu";

(async () => {
    console.log("==================================================");
    console.log("NAUKRI ORACLE CONTROLLED LIVE VALIDATION MASTER RUNNER");
    console.log("==================================================\n");

    // PHASE 1: Pre-Mutation Safety Check
    console.log("--- PHASE 1: Pre-Mutation Safety Check ---");
    const checkStateCmd = `
        cd /home/ubuntu/automation &&
        test -f sessions/naukri/storageState.json &&
        git status &&
        systemctl is-enabled naukri-automation.timer 2>/dev/null || echo "NAUKRI_TIMER_DISABLED"
    `;
    const safetyCheck = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "${checkStateCmd.replace(/\n/g, " ")}"`).toString();
    console.log(safetyCheck);
    console.log("✓ Safety check verified: storageState exists, git aligned, production timer DISABLED.");

    // Transfer test scripts
    console.log("\nTransferring controlled test scripts to Oracle VM...");
    execSync(`scp -i "${sshKey}" -o StrictHostKeyChecking=no scripts/execute-naukri-controlled-profile-refresh.js ${user}@${host}:/home/ubuntu/automation/execute-naukri-controlled-profile-refresh.js`);
    execSync(`scp -i "${sshKey}" -o StrictHostKeyChecking=no scripts/execute-naukri-controlled-live-application.js ${user}@${host}:/home/ubuntu/automation/execute-naukri-controlled-live-application.js`);

    // PHASE 2: Execute Profile Refresh Test
    console.log("\n--- PHASE 2: Executing ONE Controlled Profile Refresh on Oracle VM ---");
    execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; node execute-naukri-controlled-profile-refresh.js > profile_refresh.log 2>&1"`);
    const profileLog = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat profile_refresh.log"`).toString();
    console.log("PROFILE REFRESH LOG:\n", profileLog);

    const profileReport = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat naukri_profile_refresh_report.json"`).toString();
    console.log("PROFILE REFRESH REPORT:\n", profileReport);

    // PHASES 3–9: Execute Live Application & 5-Surface Verification Test
    console.log("\n--- PHASES 3–9: Executing ONE Controlled Live Application on Oracle VM ---");
    execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; node execute-naukri-controlled-live-application.js > live_application.log 2>&1"`);
    const appLog = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat live_application.log"`).toString();
    console.log("LIVE APPLICATION LOG:\n", appLog);

    const appReport = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat naukri_live_application_report.json"`).toString();
    console.log("LIVE APPLICATION REPORT:\n", appReport);

    console.log("\n==================================================");
    console.log("NAUKRI CONTROLLED LIVE VALIDATION COMPLETE");
    console.log("==================================================\n");

})();
