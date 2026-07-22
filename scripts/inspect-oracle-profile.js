const db = require("../packages/database");
const candidateProfile = require("../packages/knowledge/CandidateProfile");

(async () => {
    await db.init();
    const rows = await db.all("SELECT * FROM candidate_profile");
    console.log("--- ORACLE CANDIDATE_PROFILE DB ROWS ---");
    console.log("DB ROWS COUNT:", rows.length);
    rows.forEach(r => {
        const valid = candidateProfile.isProductionValueValid(r.key, r.value);
        console.log(`KEY: "${r.key}" | VAL_LEN: ${(r.value || "").length} | VALID: ${valid}`);
    });

    const prof = await candidateProfile.getProfile();
    console.log("\n--- CANDIDATE PROFILE RUNTIME GETPROFILE() ---");
    console.log(`EMAIL_LEN: ${(prof.email || "").length} | PHONE_LEN: ${(prof.phone || "").length}`);
    
    const readiness = await candidateProfile.checkPreLiveProfileReadiness();
    console.log("\n--- PRE-LIVE READINESS ---");
    console.log("IS_READY:", readiness.isReady);
    console.log("MISSING:", JSON.stringify(readiness.missingRequiredFields));
})();
