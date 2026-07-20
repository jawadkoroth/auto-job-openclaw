const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Parse command line arguments
const args = process.argv.slice(2);
const isPushRequested = args.includes("--push");
const isLiveRun = args.includes("--live");
const isHealthCheck = args.includes("--health");
const isHiristOnly = args.includes("--hirist");
const isFounditOnly = args.includes("--foundit");

// Load remote configs from .env
const remoteHost = process.env.REMOTE_HOST;
const remoteUser = process.env.REMOTE_USER || "ubuntu";
const remoteProjectPath = process.env.REMOTE_PROJECT_PATH || "/home/ubuntu/automation";
const remoteSshKey = process.env.REMOTE_SSH_KEY;

if (!remoteHost) {
    console.error("❌ Error: REMOTE_HOST is not defined in your environment or .env file.");
    process.exit(1);
}
if (!remoteSshKey) {
    console.error("❌ Error: REMOTE_SSH_KEY (path to private key) is not defined in your environment or .env file.");
    process.exit(1);
}

// 1. Verify local git status
console.log("🔍 Verifying local Git status...");
try {
    const gitStatus = execSync("git status --porcelain").toString().trim();
    if (gitStatus.length > 0) {
        console.warn("⚠️ Warning: You have uncommitted local changes:\n" + gitStatus);
        if (!args.includes("--force")) {
            console.error("❌ Error: Please commit your changes or run with --force to deploy anyway.");
            process.exit(1);
        }
    } else {
        console.log("✅ Local Git repository is clean.");
    }
} catch (err) {
    console.error("❌ Error running git status:", err.message);
    process.exit(1);
}

// 2. Git push if explicitly requested
if (isPushRequested) {
    console.log("📤 Pushing committed changes to origin/main...");
    try {
        execSync("git push origin main", { stdio: "inherit" });
        console.log("✅ Successfully pushed to origin/main.");
    } catch (err) {
        console.error("❌ Error pushing to git repository:", err.message);
        process.exit(1);
    }
}

// Sync portable storageState.json files if present locally using SCP
const sshKeyPath = path.resolve(remoteSshKey);

const founditStatePath = path.join(__dirname, "../sessions/foundit/storageState.json");
if (fs.existsSync(founditStatePath)) {
    console.log("📤 Syncing local storageState.json for Foundit to remote VM via SCP...");
    try {
        execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "mkdir -p ${remoteProjectPath}/sessions/foundit"`);
        execSync(`scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${founditStatePath}" ${remoteUser}@${remoteHost}:${remoteProjectPath}/sessions/foundit/storageState.json`, { stdio: "inherit" });
        console.log("✅ Successfully transferred Foundit storageState.json to VM.");
    } catch (e) {
        console.warn(`⚠️ Warning: Failed transferring Foundit storageState.json: ${e.message}`);
    }
}

const hiristStatePath = path.join(__dirname, "../sessions/hirist/storageState.json");
if (fs.existsSync(hiristStatePath)) {
    console.log("📤 Syncing local storageState.json for Hirist to remote VM via SCP...");
    try {
        execSync(`ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost} "mkdir -p ${remoteProjectPath}/sessions/hirist"`);
        execSync(`scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${hiristStatePath}" ${remoteUser}@${remoteHost}:${remoteProjectPath}/sessions/hirist/storageState.json`, { stdio: "inherit" });
        console.log("✅ Successfully transferred Hirist storageState.json to VM.");
    } catch (e) {
        console.warn(`⚠️ Warning: Failed transferring Hirist storageState.json: ${e.message}`);
    }
}

// Build commands to run on the Oracle VM
console.log(`🔌 Preparing to connect to remote VM: ${remoteUser}@${remoteHost}...`);

const remoteCommand = `
cd ${remoteProjectPath}
echo "=== Running Git Pull on VM ==="
git fetch origin main
LOCAL_DIFF=$(git diff --name-only HEAD origin/main)
if [ -n "$LOCAL_DIFF" ]; then
    echo "Files to update: $LOCAL_DIFF"
fi

# Attempt clean pull
if ! git pull; then
    echo "❌ Git Pull failed due to local conflicts on remote host!"
    echo "Conflicting files:"
    git status -s
    exit 1
fi

if echo "$LOCAL_DIFF" | grep -qE "package.json|package-lock.json"; then
    echo "=== Dependencies changed. Running npm install on VM ==="
    npm install
fi

echo "=== Running Target Task on VM ==="
${
    isFounditOnly
        ? "DRY_RUN=true ALLOW_LIVE_APPLICATIONS=false node scripts/test-foundit-remote.js"
        : isHiristOnly
        ? "DRY_RUN=true ALLOW_LIVE_APPLICATIONS=false node scripts/test-hirist-remote.js"
        : isHealthCheck
        ? "node scripts/production-health.js"
        : isLiveRun
        ? "DRY_RUN=false ALLOW_LIVE_APPLICATIONS=true node scripts/run-live.js"
        : "DRY_RUN=true ALLOW_LIVE_APPLICATIONS=false node scripts/run-live.js"
}
`;

// Run the ssh command locally using child_process.spawn to stream results in real time
const sshArgs = [
    "-i", sshKeyPath,
    "-o", "StrictHostKeyChecking=no",
    `${remoteUser}@${remoteHost}`,
    remoteCommand
];

console.log(`🚀 Executing SSH remote command...`);
const sshProcess = spawn("ssh", sshArgs);

sshProcess.stdout.on("data", (data) => {
    const cleanStr = data.toString().replace(/\r\r\n/g, "\n").replace(/\r\n/g, "\n");
    process.stdout.write(cleanStr);
});

sshProcess.stderr.on("data", (data) => {
    const cleanStr = data.toString().replace(/\r\r\n/g, "\n").replace(/\r\n/g, "\n");
    process.stderr.write(cleanStr);
});

sshProcess.on("close", (code) => {
    if (code === 0) {
        console.log("\n=================================");
        console.log("✅ Remote VM validation complete.");
        console.log("=================================");
    } else {
        console.error(`\n❌ Remote VM execution failed with exit code: ${code}`);
        process.exit(code);
    }
});
