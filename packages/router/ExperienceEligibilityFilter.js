/**
 * ExperienceEligibilityFilter.js
 * 
 * Enforces authoritative job experience eligibility based on 1-6 year interval overlap:
 *   target job experience range = anything overlapping 1-6 years
 *   interval overlap condition: jobMax >= 1 AND jobMin <= 6
 * 
 * Classifies missing/unparsable experience as EXPERIENCE_UNKNOWN (eligible).
 */

function parseExperience(expStr = "") {
    if (expStr === null || expStr === undefined) {
        return { min: 0, max: 99, isUnknown: true };
    }

    const text = String(expStr).trim();
    if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined" || text.toLowerCase() === "not specified" || text.toLowerCase() === "n/a") {
        return { min: 0, max: 99, isUnknown: true };
    }

    const lower = text.toLowerCase();

    // Fresher / Entry Level
    if (lower.includes("fresher") || lower.includes("entry level") || lower.includes("entry-level")) {
        return { min: 0, max: 1, isUnknown: false };
    }

    // Range format: "0-3 yrs", "0 - 3 years", "1 to 6 Years", "2 to 5 years", "5 - 8 Yrs"
    const rangeMatch = text.match(/(\d+)\s*(?:-|to)\s*(\d+)/i);
    if (rangeMatch) {
        const min = parseInt(rangeMatch[1], 10);
        const max = parseInt(rangeMatch[2], 10);
        if (!isNaN(min) && !isNaN(max)) {
            return { min: Math.min(min, max), max: Math.max(min, max), isUnknown: false };
        }
    }

    // Minimum / Plus format: "3+ years", "Minimum 2 years", "min 2 yrs", "2+ Yrs", "at least 3 years"
    const plusMatch = text.match(/(\d+)\s*\+/);
    if (plusMatch) {
        const min = parseInt(plusMatch[1], 10);
        if (!isNaN(min)) {
            return { min, max: 99, isUnknown: false };
        }
    }

    const minMatch = text.match(/(?:minimum|min|at least)\s*(\d+)/i);
    if (minMatch) {
        const min = parseInt(minMatch[1], 10);
        if (!isNaN(min)) {
            return { min, max: 99, isUnknown: false };
        }
    }

    // Maximum format: "Up to 5 years", "max 5 years"
    const maxMatch = text.match(/(?:up to|max(?:imum)?)\s*(\d+)/i);
    if (maxMatch) {
        const max = parseInt(maxMatch[1], 10);
        if (!isNaN(max)) {
            return { min: 0, max, isUnknown: false };
        }
    }

    // Single number: "3 years", "5 yrs"
    const singleMatch = text.match(/(\d+)/);
    if (singleMatch) {
        const num = parseInt(singleMatch[1], 10);
        if (!isNaN(num)) {
            return { min: num, max: num, isUnknown: false };
        }
    }

    // Ambiguous / unparsable
    return { min: 0, max: 99, isUnknown: true };
}

function checkExperienceEligibility(expStr = "") {
    const parsed = parseExperience(expStr);

    if (parsed.isUnknown) {
        return {
            eligible: true,
            min: parsed.min,
            max: parsed.max,
            category: "EXPERIENCE_UNKNOWN",
            reason: `ELIGIBLE (UNKNOWN): Experience string "${expStr}" is missing or unparsable. Allowed for downstream matching.`
        };
    }

    // Interval overlap with [1, 6]: jobMax >= 1 AND jobMin <= 6
    const eligible = (parsed.max >= 1) && (parsed.min <= 6);

    if (eligible) {
        return {
            eligible: true,
            min: parsed.min,
            max: parsed.max,
            category: "ELIGIBLE",
            reason: `ELIGIBLE: Job experience range ${parsed.min}-${parsed.max} yrs overlaps target [1-6] yrs.`
        };
    }

    return {
        eligible: false,
        min: parsed.min,
        max: parsed.max,
        category: "EXPERIENCE_MISMATCH",
        reason: `EXPERIENCE_MISMATCH: Job experience range ${parsed.min}-${parsed.max} yrs does not overlap target [1-6] yrs.`
    };
}

module.exports = {
    parseExperience,
    checkExperienceEligibility
};
