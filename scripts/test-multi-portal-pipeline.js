const assert = require("assert");
const http = require("http");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");

async function runMultiPortalPipelineTest() {
    console.log("==================================================");
    console.log("OPENCLAW MULTI-PORTAL PIPELINE & REGRESSION SUITE");
    console.log("==================================================\n");

    const db = require("../packages/database");
    await db.init();

    // 1. Test Location Eligibility Filter
    console.log("[Test 1] Location Eligibility Filter...");
    
    const resUsOnly = checkLocationEligibility("Remote (US Only)", "DevOps Engineer");
    assert.strictEqual(resUsOnly.eligible, false, "US Only job must be rejected");
    console.log("  ✅ US Only rejection: PASS");

    const resEuOnly = checkLocationEligibility("Remote - EU Only", "Cloud Engineer");
    assert.strictEqual(resEuOnly.eligible, false, "EU Only job must be rejected");
    console.log("  ✅ EU Only rejection: PASS");

    const resWorldwide = checkLocationEligibility("Remote (Worldwide)", "Platform Engineer");
    assert.strictEqual(resWorldwide.eligible, true, "Worldwide job must be accepted");
    console.log("  ✅ Worldwide inclusion: PASS");

    const resIndia = checkLocationEligibility("Bengaluru / Remote", "DevOps Engineer");
    assert.strictEqual(resIndia.eligible, true, "India job must be accepted");
    console.log("  ✅ India location inclusion: PASS");

    // 2. Test Portals Matrix Endpoint
    console.log("\n[Test 2] Dashboard Portals Matrix API...");
    const dashboardServer = require("../apps/dashboard/server");
    const PORT = 3009;
    const authHeader = "Basic " + Buffer.from("admin:openclaw2026").toString("base64");

    const server = dashboardServer.listen(PORT, "127.0.0.1", async () => {
        try {
            const res = await new Promise((resolve, reject) => {
                const req = http.request(`http://127.0.0.1:${PORT}/api/portals/matrix`, {
                    headers: { "Authorization": authHeader }
                }, (response) => {
                    let body = "";
                    response.on("data", chunk => body += chunk);
                    response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(body) }));
                });
                req.on("error", reject);
                req.end();
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.success, true);
            assert.ok(Array.isArray(res.json.portals), "Portals matrix must return an array");
            assert.ok(res.json.portals.length >= 16, "Must contain at least 16 researched portals");
            console.log(`  ✅ Portals Matrix API returned ${res.json.portals.length} portals: PASS`);

            // Verify specific portal status classifications
            const hirist = res.json.portals.find(p => p.name === "Hirist");
            assert.strictEqual(hirist.status, "ACTIVE");

            const foundit = res.json.portals.find(p => p.name === "Foundit");
            assert.ok(foundit.status.includes("ACTIVE"));

            const remotive = res.json.portals.find(p => p.name === "Remotive");
            assert.strictEqual(remotive.status, "BLOCKED_FROM_ORACLE");

            const naukri = res.json.portals.find(p => p.name === "Naukri");
            assert.strictEqual(naukri.status, "MANUAL_APPLICATION_ONLY");

            console.log("  ✅ Portal Trust & Status Classifications: PASS");

            server.close();
            console.log("\n==================================================");
            console.log("ALL MULTI-PORTAL PIPELINE TESTS PASSED");
            console.log("==================================================\n");
            process.exit(0);
        } catch (err) {
            console.error("❌ Test failure:", err);
            server.close();
            process.exit(1);
        }
    });
}

runMultiPortalPipelineTest().catch(console.error);
