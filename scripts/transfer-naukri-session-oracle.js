const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const sshKey = process.env.REMOTE_SSH_KEY;
const host = process.env.REMOTE_HOST || "140.245.212.88";
const user = process.env.REMOTE_USER || "ubuntu";

(async () => {
    console.log("==================================================");
    console.log("NAUKRI SECURE ORACLE SESSION TRANSFER & FEASIBILITY RUNNER");
    console.log("==================================================\n");

    const localStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");

    if (!fs.existsSync(localStatePath)) {
        console.error("❌ Local sessions/naukri/storageState.json not found.");
        console.error("Please run: node scripts/setup-naukri-session.js first!");
        process.exit(1);
    }

    console.log("[1/4] Confirming local storageState.json existence...");
    const stats = fs.statSync(localStatePath);
    console.log(`✓ Local storageState.json found (${stats.size} bytes).`);

    console.log("\n[2/4] Transferring storageState.json to Oracle VM...");
    execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p /home/ubuntu/automation/sessions/naukri"`);
    execSync(`scp -i "${sshKey}" -o StrictHostKeyChecking=no "${localStatePath}" ${user}@${host}:/home/ubuntu/automation/sessions/naukri/storageState.json`);
    execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "chmod 600 /home/ubuntu/automation/sessions/naukri/storageState.json"`);
    console.log("✓ File transferred successfully to /home/ubuntu/automation/sessions/naukri/storageState.json with restricted permissions (chmod 600).");

    console.log("\n[3/4] Transferring Phase 3-7 Feasibility Test Suite to Oracle VM...");
    execSync(`scp -i "${sshKey}" -o StrictHostKeyChecking=no scratch/oracle_naukri_full_feasibility_test.js ${user}@${host}:/home/ubuntu/automation/oracle_naukri_full_feasibility_test.js`);

    console.log("\n[4/4] Executing Phases 3, 4, 5, 6 & 7 Validation Suite on Oracle VM...");
    execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; node oracle_naukri_full_feasibility_test.js > oracle_feasibility_full.log 2>&1"`);

    console.log("\nReading log output from Oracle VM...");
    const logOutput = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat oracle_feasibility_full.log"`).toString();
    console.log("LOG OUTPUT:\n", logOutput);

    const jsonReport = execSync(`ssh -i "${sshKey}" -o StrictHostKeyChecking=no ${user}@${host} "cd /home/ubuntu/automation ; cat oracle_naukri_feasibility_full_report.json"`).toString();
    console.log("\nJSON REPORT:\n", jsonReport);

    console.log("\n==================================================");
    console.log("ORACLE FEASIBILITY VALIDATION COMPLETE");
    console.log("==================================================\n");
})();
