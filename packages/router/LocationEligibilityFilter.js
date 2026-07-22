/**
 * LocationEligibilityFilter.js
 * 
 * Enforces strict location rules for Global Remote and India jobs.
 * Rejects remote jobs explicitly restricted to US, Canada, EU, UK, LATAM, or US States,
 * while categorizing Worldwide, APAC, and India listings.
 */

function checkLocationEligibility(locationStr = "", titleStr = "") {
    const loc = (locationStr || "").trim();
    const text = `${loc} ${titleStr}`.toLowerCase();

    if (!loc) {
        return {
            eligible: false,
            category: "LOCATION_UNKNOWN",
            reason: "LOCATION_ELIGIBILITY_UNRESOLVED: Location string is empty or unparsable."
        };
    }

    // Explicit exclusions (US States, North America, EU, etc.)
    const ineligibleKeywords = [
        "us only", "usa only", "united states only", "u.s. only", "u.s.a. only",
        "us/canada", "us & canada", "us or canada", "canada only",
        "eu only", "uk only", "united kingdom only",
        "latam only", "latin america only", "americas only", "north america only",
        "germany only", "australia only", "japan only",
        // US & Canadian States / Regions
        "virginia", "colorado", "florida", "texas", "new jersey", "quebec", "ontario", "arkansas",
        "california", "new york", "massachusetts", "washington", "illinois"
    ];

    for (const kw of ineligibleKeywords) {
        if (text.includes(kw)) {
            return {
                eligible: false,
                category: "LOCATION_RESTRICTED",
                reason: `LOCATION_RESTRICTED: "${kw.toUpperCase()}" excludes candidates in India.`,
                matchedKeyword: kw
            };
        }
    }

    // Worldwide Eligible
    if (text.includes("worldwide") || text.includes("anywhere") || text.includes("everywhere") || text.includes("global") || text.includes("all locations")) {
        return {
            eligible: true,
            category: "WORLDWIDE_ELIGIBLE",
            reason: "ELIGIBLE: Explicit worldwide remote listing."
        };
    }

    // APAC Eligible
    if (text.includes("apac") || text.includes("asia")) {
        return {
            eligible: true,
            category: "APAC_ELIGIBLE",
            reason: "ELIGIBLE: Explicit APAC/Asia remote listing."
        };
    }

    // India Eligible
    if (text.includes("india") || text.includes("bengaluru") || text.includes("bangalore") || text.includes("mumbai") || text.includes("delhi") || text.includes("pune") || text.includes("hyderabad")) {
        return {
            eligible: true,
            category: "INDIA_ELIGIBLE",
            reason: "ELIGIBLE: Explicit India location listing."
        };
    }

    // Unresolved / Unknown Location
    return {
        eligible: false,
        category: "LOCATION_UNKNOWN",
        reason: "LOCATION_ELIGIBILITY_UNRESOLVED: Location cannot be confidently established as India/Worldwide eligible."
    };
}

module.exports = {
    checkLocationEligibility
};
