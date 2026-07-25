const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

(async () => {
    console.log("==================================================");
    console.log("PHASE 2 — TRANSFER SESSION TO ORACLE VM");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    const localStatePath = path.join(__dirname, "../sessions/cutshort/storageState.json");
    if (!fs.existsSync(localStatePath)) {
        console.error("❌ Local sessions/cutshort/storageState.json does not exist!");
        process.exit(1);
    }

    const remoteHost = process.env.REMOTE_HOST || "140.245.212.88";
    const remoteUser = process.env.REMOTE_USER || "ubuntu";
    const remoteProjectPath = process.env.REMOTE_PROJECT_PATH || "/home/ubuntu/automation";
    const remoteSshKey = process.env.REMOTE_SSH_KEY;

    if (!remoteSshKey || !fs.existsSync(path.resolve(remoteSshKey))) {
        console.error("❌ PRIVATE SSH KEY FILE NOT FOUND OR NOT CONFIGURED IN .env (REMOTE_SSH_KEY).");
        console.error("   Local storageState.json is ready for manual scp if SSH key is outside workspace.");
        process.exit(1);
    }

    const sshKeyPath = path.resolve(remoteSshKey);
    const remoteSessionDir = `${remoteProjectPath}/sessions/cutshort`;
    const remoteStateFile = `${remoteSessionDir}/storageState.json`;

    console.log(`Local Session File: ${localStatePath}`);
    console.log(`Remote Target:      ${remoteUser}@${remoteHost}:${remoteStateFile}\n`);

    try {
        console.log("1. Creating remote directory /home/ubuntu/automation/sessions/cutshort...");
        execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "mkdir -p ${remoteSessionDir}"`, { stdio: "inherit" });

        console.log("2. Copying storageState.json via SCP...");
        execSync(`scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${localStatePath}" ${remoteUser}@${remoteHost}:${remoteStateFile}`, { stdio: "inherit" });

        console.log("3. Setting restrictive permissions (chmod 700 directory, chmod 600 storageState.json)...");
        execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "chmod 700 ${remoteSessionDir} && chmod 600 ${remoteStateFile}"`, { stdio: "inherit" });

        console.log("\n==================================================");
        console.log("SESSION TRANSFER TO ORACLE RESULT: PASS");
        console.log("==================================================\n");

    } catch (e) {
        console.error(`❌ SSH/SCP Transfer Error: ${e.message}`);
        process.exit(1);
    }
})();
