const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");

async function runE2eSyncTest() {
    console.log("==================================================");
    console.log("CANDIDATE KNOWLEDGE E2E VERIFICATION SUITE");
    console.log("==================================================\n");

    const db = require("../packages/database");
    const candidateProfile = require("../packages/knowledge/CandidateProfile");
    const candidateKnowledgeSync = require("../packages/knowledge/CandidateKnowledgeSync");

    await db.init();

    // 1. Verify Local Profile Contains Valid Production Email and Phone
    const localStatus = await candidateProfile.getSanitizedProfileStatus();
    assert.strictEqual(localStatus.emailPresent, true, "Local Profile email must be present");
    assert.strictEqual(localStatus.emailIsPlaceholder, false, "Local Profile email must not be placeholder");
    assert.strictEqual(localStatus.phonePresent, true, "Local Profile phone must be present");
    assert.strictEqual(localStatus.phoneIsPlaceholder, false, "Local Profile phone must not be placeholder");
    console.log("✅ Local Profile Valid: PASS");

    // 2. Export Candidate Knowledge Sync Payload
    const syncPayloadPath = await candidateKnowledgeSync.exportSyncPayload();
    assert.ok(await fs.pathExists(syncPayloadPath), "Sync payload JSON file must exist");

    const payload = await fs.readJson(syncPayloadPath);
    assert.ok(Array.isArray(payload.candidate_profile), "Payload candidate_profile must be an array");
    const emailRow = payload.candidate_profile.find(r => r.key === "email");
    const phoneRow = payload.candidate_profile.find(r => r.key === "phone");
    assert.ok(emailRow && emailRow.value && emailRow.value.length > 0, "Payload must contain canonical email key");
    assert.ok(phoneRow && phoneRow.value && phoneRow.value.length > 0, "Payload must contain canonical phone key");
    console.log("✅ Export Payload: PASS");

    // 3. Test Import on Database and Verify Consistency & Reload
    const importRes = await candidateKnowledgeSync.importSyncPayload(syncPayloadPath);
    assert.ok(importRes.profileCount > 0, "Profile rows must be imported");
    console.log("✅ Oracle Import: PASS");

    assert.strictEqual(db.getDbPath().includes("database.sqlite"), true, "Database path consistency verified");
    console.log("✅ Knowledge DB Consistency: PASS");

    // 4. Verify Runtime Reload and Pre-Live Profile Readiness Check
    const reloadedStatus = await candidateProfile.getSanitizedProfileStatus();
    assert.strictEqual(reloadedStatus.emailPresent, true, "Reloaded email must be present");
    assert.strictEqual(reloadedStatus.emailIsPlaceholder, false, "Reloaded email must not be placeholder");
    console.log("✅ Oracle Email Resolution: PASS");

    assert.strictEqual(reloadedStatus.phonePresent, true, "Reloaded phone must be present");
    assert.strictEqual(reloadedStatus.phoneIsPlaceholder, false, "Reloaded phone must not be placeholder");
    console.log("✅ Oracle Phone Resolution: PASS");

    const readiness = await candidateProfile.checkPreLiveProfileReadiness();
    assert.strictEqual(readiness.isReady, true, "Pre-live readiness check must pass");
    console.log("✅ Runtime Profile Reload & Pre-Live Profile Check: PASS");

    console.log("\n==================================================");
    console.log("CANDIDATE KNOWLEDGE E2E VERIFICATION SUMMARY");
    console.log("==================================================");
    console.log("Local Profile Valid: PASS");
    console.log("Export Payload: PASS");
    console.log("Oracle Import: PASS");
    console.log("Knowledge DB Consistency: PASS");
    console.log("Runtime Profile Reload: PASS");
    console.log("Oracle Email Resolution: PASS");
    console.log("Oracle Phone Resolution: PASS");
    console.log("Oracle Pre-Live Profile Check: PASS");
    console.log("==================================================\n");
}

runE2eSyncTest().catch(err => {
    console.error("❌ E2E Sync Test Failure:", err.message, err.stack);
    process.exit(1);
});
