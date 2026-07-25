const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT PRODUCTION DEPLOYMENT TO ORACLE VM");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    const remoteHost = process.env.REMOTE_HOST || "140.245.212.88";
    const remoteUser = process.env.REMOTE_USER || "ubuntu";
    const remoteProjectPath = process.env.REMOTE_PROJECT_PATH || "/home/ubuntu/automation";
    const remoteSshKey = process.env.REMOTE_SSH_KEY;

    if (!remoteSshKey || !fs.existsSync(path.resolve(remoteSshKey))) {
        console.error("❌ PRIVATE SSH KEY FILE NOT FOUND OR NOT CONFIGURED IN .env (REMOTE_SSH_KEY).");
        process.exit(1);
    }

    const sshKeyPath = path.resolve(remoteSshKey);
    const localStatePath = path.join(__dirname, "../sessions/cutshort/storageState.json");
    const remoteSessionDir = `${remoteProjectPath}/sessions/cutshort`;
    const remoteStateFile = `${remoteSessionDir}/storageState.json`;

    console.log("[1/4] Syncing storageState.json & Environment Config to Oracle VM...");
    execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "mkdir -p ${remoteSessionDir}"`, { stdio: "inherit" });
    execSync(`scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${localStatePath}" ${remoteUser}@${remoteHost}:${remoteStateFile}`, { stdio: "inherit" });
    execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "chmod 700 ${remoteSessionDir} && chmod 600 ${remoteStateFile}"`, { stdio: "inherit" });
    console.log("✓ Session storageState.json transferred with chmod 600.");

    console.log("\n[2/4] Deploying Scripts & Systemd Unit Files to Oracle VM...");
    
    // Copy scripts and systemd units via SCP
    const filesToCopy = [
        "scripts/run-cutshort-production.js",
        "scripts/run-cutshort-conversation-monitor.js",
        "docker/systemd/cutshort-automation.service",
        "docker/systemd/cutshort-automation.timer",
        "docker/systemd/cutshort-conversation-monitor.service",
        "docker/systemd/cutshort-conversation-monitor.timer"
    ];

    for (const f of filesToCopy) {
        const localPath = path.join(__dirname, "..", f);
        const remoteDest = `${remoteProjectPath}/${f}`;
        const remoteDir = path.dirname(remoteDest);
        execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "mkdir -p ${remoteDir}"`);
        execSync(`scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${localPath}" ${remoteUser}@${remoteHost}:${remoteDest}`);
    }
    console.log("✓ All scripts and systemd unit files deployed.");

    console.log("\n[3/4] Registering & Enabling Cutshort Systemd Timers on Oracle VM...");
    const systemdRemoteCommand = `
        sudo cp ${remoteProjectPath}/docker/systemd/cutshort-automation.service /etc/systemd/system/ ;
        sudo cp ${remoteProjectPath}/docker/systemd/cutshort-automation.timer /etc/systemd/system/ ;
        sudo cp ${remoteProjectPath}/docker/systemd/cutshort-conversation-monitor.service /etc/systemd/system/ ;
        sudo cp ${remoteProjectPath}/docker/systemd/cutshort-conversation-monitor.timer /etc/systemd/system/ ;
        sudo systemctl daemon-reload ;
        sudo systemctl enable --now cutshort-automation.timer ;
        sudo systemctl enable --now cutshort-conversation-monitor.timer
    `;

    execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "${systemdRemoteCommand.replace(/\n/g, " ")}"`, { stdio: "inherit" });
    console.log("✓ Cutshort systemd timers registered and enabled!");

    console.log("\n[4/4] Auditing Oracle Systemd Runtime Status & Timers...");
    const statusRemoteCommand = `sudo systemctl status cutshort-automation.timer cutshort-conversation-monitor.timer --no-pager ; sudo systemctl list-timers --all --no-pager`;

    const statusOutput = execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "${statusRemoteCommand}"`).toString();
    console.log(statusOutput);

    console.log("==================================================");
    console.log("CUTSHORT PRODUCTION ACTIVATION COMPLETE");
    console.log("==================================================\n");
})();
