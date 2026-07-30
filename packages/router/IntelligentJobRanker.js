const { checkExperienceEligibility } = require("./ExperienceEligibilityFilter");
const { checkLocationEligibility } = require("./LocationEligibilityFilter");

/**
 * Deterministic, explainable ranking engine for candidate job matches
 */
class IntelligentJobRanker {
    /**
     * Calculate comprehensive match score and explanation for a job listing
     * @param {Object} job Job card object (title, company, experience, location, url, skills)
     * @param {Object} candidateProfile CandidateProfile SSOT object
     * @returns {Object} { rankScore, isEligible, breakdown, selectionReason }
     */
    rankJob(job, candidateProfile = {}) {
        const title = (job.title || "").trim();
        const company = (job.company || "").trim();
        const experienceStr = (job.experience || "").trim();
        const locationStr = (job.location || "").trim();
        const skillsText = (job.skills || job.relevantSkills || "").trim().toLowerCase();
        const titleLower = title.toLowerCase();

        // 1. Mandatory Eligibility Checks (Baseline Guard)
        const expCheck = checkExperienceEligibility(experienceStr);
        const locCheck = checkLocationEligibility(locationStr, title);

        if (!expCheck.eligible || !locCheck.eligible) {
            return {
                rankScore: 0,
                isEligible: false,
                ineligibleReason: !expCheck.eligible ? expCheck.reason : locCheck.reason,
                breakdown: { role: 0, experience: 0, skill: 0, location: 0 },
                selectionReason: "INELIGIBLE"
            };
        }

        let roleScore = 0;
        let experienceScore = 0;
        let skillScore = 0;
        let locationScore = 0;
        const matchedSkillsList = [];

        // --- A. ROLE RELEVANCE SCORE (Max 40 Pts) ---
        const directDevOpsRoles = [
            "devops engineer", "cloud engineer", "cloud devops engineer",
            "platform engineer", "infrastructure engineer", "cloud infrastructure engineer",
            "aws cloud engineer", "aws devops engineer", "azure devops engineer",
            "gcp devops engineer", "cloud operations engineer", "build & release engineer",
            "ci/cd engineer", "kubernetes engineer", "devops platform engineer"
        ];

        const secondaryDevOpsRoles = [
            "site reliability engineer", "sre", "cloud systems engineer",
            "system administrator", "linux engineer", "devsecops engineer"
        ];

        const demotedRoles = [
            "architect", "principal architect", "engineering manager",
            "director", "head of engineering", "frontend", "mobile",
            "data scientist", "qa", "tester", "full stack"
        ];

        const isDemoted = demotedRoles.some(r => titleLower.includes(r));
        const isDirect = directDevOpsRoles.some(r => titleLower.includes(r));
        const isSecondary = secondaryDevOpsRoles.some(r => titleLower.includes(r));

        if (isDemoted) {
            roleScore = 15;
        } else if (isDirect) {
            roleScore = 40;
        } else if (isSecondary) {
            roleScore = 30;
        } else {
            roleScore = 20;
        }

        // --- B. EXPERIENCE FIT SCORE (Max 25 Pts) & UPPER RANGE PENALTY ---
        const minMatch = experienceStr.match(/^(\d+)/);
        const maxMatch = experienceStr.match(/(\d+)\s*Yr/i) || experienceStr.match(/(\d+)$/);
        const minExp = minMatch ? parseInt(minMatch[1], 10) : 0;
        const maxExp = maxMatch ? parseInt(maxMatch[1], 10) : 10;
        const rangeWidth = Math.max(1, maxExp - minExp);

        if (minExp >= 2 && maxExp <= 6) {
            experienceScore = 25; // Ideal tight mid-level range (e.g. 2-5, 3-5, 3-6)
        } else if (minExp <= 1 && maxExp <= 5) {
            experienceScore = 22; // Good entry/mid range (e.g. 0-3, 1-3, 1-4)
        } else if (maxExp <= 7) {
            experienceScore = 18; // Slightly broader mid range (e.g. 2-6, 4-6)
        } else if (rangeWidth > 6) {
            experienceScore = 12; // Very broad range (e.g. 0-10, 1-10)
        } else {
            experienceScore = 15;
        }

        // Apply penalty for upper YOE ranges exceeding 6 years
        let yoePenalty = 0;
        if (maxExp > 6) {
            yoePenalty = (maxExp - 6) * 10;
        }

        // --- C. SKILL ALIGNMENT SCORE (Max 25 Pts) ---
        const primarySkills = ["aws", "kubernetes", "terraform", "docker", "ci/cd", "linux"];
        const secondarySkills = ["python", "jenkins", "ansible", "azure", "gcp", "prometheus", "grafana", "github actions"];

        const combinedText = `${titleLower} ${skillsText}`;

        for (const skill of primarySkills) {
            if (combinedText.includes(skill)) {
                skillScore += 4;
                matchedSkillsList.push(skill.toUpperCase());
            }
        }
        for (const skill of secondarySkills) {
            if (combinedText.includes(skill)) {
                skillScore += 2.5;
                matchedSkillsList.push(skill.toUpperCase());
            }
        }
        skillScore = Math.min(25, skillScore);
        if (skillScore === 0) skillScore = 10; // Baseline skill match for target title

        // --- D. LOCATION SCORE (Max 10 Pts) ---
        const locLower = locationStr.toLowerCase();
        if (locLower.includes("bangalore") || locLower.includes("bengaluru") || locLower.includes("remote") || locLower.includes("hybrid")) {
            locationScore = 10;
        } else if (locLower.includes("hyderabad") || locLower.includes("pune") || locLower.includes("chennai") || locLower.includes("mumbai") || locLower.includes("gurugram") || locLower.includes("noida")) {
            locationScore = 7;
        } else {
            locationScore = 5;
        }

        // --- E. NATIVE VS EXTERNAL PREFERENCE BONUS ---
        let nativeBonus = 0;
        const isExternal = job.isExternal === true || job.applyType === 'EXTERNAL';
        if (!isExternal) {
            nativeBonus = 50; // Heavily prioritize native Naukri applications
        } else {
            nativeBonus = -30;
        }

        const rawScore = roleScore + experienceScore + skillScore + locationScore + nativeBonus - yoePenalty;
        const totalScore = Math.max(0, Math.min(150, rawScore));

        const skillsMatchedStr = matchedSkillsList.length > 0 ? matchedSkillsList.join(", ") : "DevOps/Cloud Skills";
        const selectionReason = `Score: ${totalScore} | ${!isExternal ? 'NATIVE NAUKRI (+50)' : 'EXTERNAL (-30)'} | Role (${roleScore}/40) + Exp ${experienceStr} (${experienceScore}/25 - ${yoePenalty} yoePenalty) + Skills [${skillsMatchedStr}] (${Math.round(skillScore)}/25)`;

        return {
            rankScore: totalScore,
            isEligible: true,
            breakdown: {
                role: roleScore,
                experience: experienceScore,
                skill: Math.round(skillScore),
                location: locationScore,
                nativeBonus,
                yoePenalty
            },
            skillsMatched: matchedSkillsList,
            selectionReason
        };
    }

    /**
     * Rank and sort array of eligible candidate jobs in descending order of match score
     * @param {Array<Object>} jobs 
     * @param {Object} candidateProfile 
     * @returns {Array<Object>} Ranked jobs sorted by rankScore DESC
     */
    rankAndSortJobs(jobs, candidateProfile = {}) {
        const ranked = [];

        for (const job of jobs) {
            const rankResult = this.rankJob(job, candidateProfile);
            if (rankResult.isEligible) {
                ranked.push({
                    ...job,
                    rankScore: rankResult.rankScore,
                    breakdown: rankResult.breakdown,
                    skillsMatched: rankResult.skillsMatched,
                    selectionReason: rankResult.selectionReason
                });
            }
        }

        // Sort descending by rank score
        ranked.sort((a, b) => b.rankScore - a.rankScore);

        return ranked;
    }

    rankJobs(jobs, candidateProfile = {}) {
        return this.rankAndSortJobs(jobs, candidateProfile);
    }
}

module.exports = new IntelligentJobRanker();
