/**
 * LocationEligibilityFilter.js
 * 
 * Enforces strict location rules for Global Remote and India jobs.
 * Rejects remote jobs explicitly restricted to US, Canada, EU, UK, LATAM, etc.,
 * while accepting India, APAC, Worldwide, Global, and Anywhere listings.
 */

function checkLocationEligibility(locationStr = "", titleStr = "") {
    const text = `${locationStr} ${titleStr}`.toLowerCase();

    // Explicit exclusions that disqualify candidates located in India
    const ineligibleKeywords = [
        "us only", "usa only", "united states only", "u.s. only", "u.s.a. only",
        "us/canada", "us & canada", "us or canada", "canada only",
        "eu only", "uk only", "united kingdom only",
        "latam only", "latin america only",
        "americas only", "north america only",
        "germany only", "australia only", "japan only"
    ];

    for (const kw of ineligibleKeywords) {
        if (text.includes(kw)) {
            return {
                eligible: false,
                reason: `LOCATION_RESTRICTED: "${kw.toUpperCase()}" excludes candidates in India.`,
                matchedKeyword: kw
            };
        }
    }

    // Explicit inclusions for India candidates
    const indiaEligibleKeywords = [
        "worldwide", "everywhere", "anywhere", "global", "all locations",
        "india", "apac", "asia", "emea/apac", "remote (india)", "remote - india",
        "work from home - india", "pan india"
    ];

    for (const kw of indiaEligibleKeywords) {
        if (text.includes(kw)) {
            return {
                eligible: true,
                reason: `ELIGIBLE: Matches explicit India-friendly region "${kw}".`,
                matchedKeyword: kw
            };
        }
    }

    // Default: if no explicit US/EU restriction is stated, allow for evaluation
    return {
        eligible: true,
        reason: "ELIGIBLE: No geographic restriction excluding India detected.",
        matchedKeyword: null
    };
}

module.exports = {
    checkLocationEligibility
};
