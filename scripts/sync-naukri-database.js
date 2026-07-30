const path = require("path");
const fs = require("fs-extra");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const remoteHost = process.env.REMOTE_HOST;
const remoteUser = process.env.REMOTE_USER || "ubuntu";
const remoteProjectPath = process.env.REMOTE_PROJECT_PATH || "/home/ubuntu/automation";
const remoteSshKey = process.env.REMOTE_SSH_KEY;

function getSshKeyPath() {
    if (!remoteSshKey) return null;
    return path.resolve(remoteSshKey);
}

async function pullDatabase() {
    console.log("📥 [DB Sync] Pulling latest production SQLite database from Oracle VM...");
    const sshKey = getSshKeyPath();
    if (!remoteHost || !sshKey || !fs.existsSync(sshKey)) {
        console.warn("⚠️ Remote SSH configuration missing or SSH key not found. Skipping DB pull.");
        return false;
    }
    const localDbPath = path.join(__dirname, "../database.sqlite");
    const tempDbPath = path.join(__dirname, "../database.sqlite.tmp");
    try {
        const scpCmd = `scp -i "${sshKey}" -o StrictHostKeyChecking=no ${remoteUser}@${remoteHost}:${remoteProjectPath}/database.sqlite "${tempDbPath}"`;
        execSync(scpCmd, { stdio: "inherit" });

        if (fs.existsSync(tempDbPath) && fs.statSync(tempDbPath).size > 0) {
            fs.copyFileSync(tempDbPath, localDbPath);
            fs.removeSync(tempDbPath);
            console.log(`✅ [DB Sync] Successfully pulled production database (${(fs.statSync(localDbPath).size / 1024 / 1024).toFixed(2)} MB).`);
            return true;
        }
    } catch (err) {
        console.error(`❌ [DB Sync] Failed to pull database from Oracle: ${err.message}`);
        if (fs.existsSync(tempDbPath)) fs.removeSync(tempDbPath);
    }
    return false;
}

async function pushDatabase() {
    console.log("📤 [DB Sync] Pushing updated SQLite database to Oracle VM...");
    const sshKey = getSshKeyPath();
    if (!remoteHost || !sshKey || !fs.existsSync(sshKey)) {
        console.warn("⚠️ Remote SSH configuration missing or SSH key not found. Skipping DB push.");
        return false;
    }
    const localDbPath = path.join(__dirname, "../database.sqlite");
    if (!fs.existsSync(localDbPath)) {
        console.error("❌ Local database.sqlite does not exist. Skipping push.");
        return false;
    }
    try {
        const scpCmd = `scp -i "${sshKey}" -o StrictHostKeyChecking=no "${localDbPath}" ${remoteUser}@${remoteHost}:${remoteProjectPath}/database.sqlite`;
        execSync(scpCmd, { stdio: "inherit" });
        console.log("✅ [DB Sync] Successfully pushed updated database to Oracle VM.");
        return true;
    } catch (err) {
        console.error(`❌ [DB Sync] Failed to push database to Oracle: ${err.message}`);
        return false;
    }
}

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        if (args.includes("--pull")) {
            await pullDatabase();
        } else if (args.includes("--push")) {
            await pushDatabase();
        } else {
            console.log("Usage: node scripts/sync-naukri-database.js --pull | --push");
        }
    })();
}

module.exports = { pullDatabase, pushDatabase };
