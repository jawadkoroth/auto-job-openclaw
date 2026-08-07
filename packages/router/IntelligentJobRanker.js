const { checkExperienceEligibility, parseExperience } = require("./ExperienceEligibilityFilter");
const { checkLocationEligibility } = require("./LocationEligibilityFilter");

/**
 * Deterministic, explainable ranking engine v2 for candidate job matches.
 * Centrally enforces role preferences, SRE exclusion, continuous recency scoring, YOE fit, apply-type prioritization, and portal-agnostic ranking.
 */
class IntelligentJobRanker {
    /**
     * Check if a job title represents an SRE / Site Reliability role that must be excluded completely.
     * @param {string} title 
     * @returns {boolean} True if SRE role to exclude
     */
    isSreRole(title = "") {
        const titleLower = (title || "").toLowerCase();
        const sreRegex = /\bsite reliability\b|\breliability engineer\b|\breliability platform engineer\b|\bsre\b/i;
        return sreRegex.test(titleLower);
    }

    /**
     * Centralized detection for Apply Type across all job portals (LinkedIn, Naukri, Cutshort, Hirist, Foundit, WWR, etc.)
     * Returns 'NATIVE' (+400), 'EASY_APPLY' (+250), or 'EXTERNAL' (-100).
     * @param {Object} job 
     * @returns {string} 'NATIVE' | 'EASY_APPLY' | 'EXTERNAL'
     */
    detectApplyType(job = {}) {
        if (!job) return 'EXTERNAL';

        const applyTypeRaw = (job.applyType || "").toString().toLowerCase().trim();
        const buttonTextRaw = (job.buttonText || "").toString().toLowerCase().trim();
        const portal = (job.portal || "").toString().toLowerCase().trim();
        const url = (job.url || "").toString().toLowerCase().trim();

        // 1. Easy Apply / One-Click Apply Detection
        if (
            job.isEasyApply === true || 
            applyTypeRaw === 'easy_apply' || 
            applyTypeRaw === 'easy apply' ||
            /easy apply|one-click|quick apply/i.test(applyTypeRaw) ||
            /easy apply|one-click|quick apply/i.test(buttonTextRaw)
        ) {
            return 'EASY_APPLY';
        }

        // 2. Explicit External Detection
        if (
            job.isExternal === true || 
            applyTypeRaw === 'external' || 
            /external|company site|company website|apply on company site/i.test(applyTypeRaw) ||
            /external|company site|company website|apply on company site/i.test(buttonTextRaw)
        ) {
            return 'EXTERNAL';
        }

        // 3. Explicit Native Detection
        if (
            job.isNative === true || 
            applyTypeRaw === 'native' || 
            /native|in-app|instant apply/i.test(applyTypeRaw)
        ) {
            return 'NATIVE';
        }

        // 4. Portal-specific default classifications
        if (portal === 'weworkremotely' || portal === 'remoteok') {
            return 'EXTERNAL';
        }

        // LinkedIn default: if not explicit Easy Apply, standard LinkedIn links point to external company site
        if (portal === 'linkedin') {
            if (/easy apply/i.test(`${job.title || ''} ${job.description || ''}`)) {
                return 'EASY_APPLY';
            }
            return 'EXTERNAL';
        }

        // Default for Naukri, Cutshort, Hirist, Foundit, Instahyre native cards:
        return 'NATIVE';
    }

    /**
     * Calculate continuous recency score boost based on job age/posting date.
     * 0-24h: +100 | 24-48h: +80 | 48-72h: +60 | 3-5d: +40 | 5-7d: +25 | 7-15d: +10 | Older / Missing: 0
     * @param {Object} job 
     * @returns {number} Recency score
     */
    calculateRecencyScore(job) {
        if (job.ageDays !== undefined && job.ageDays !== null && !isNaN(Number(job.ageDays))) {
            const days = Number(job.ageDays);
            if (days <= 1) return 100;
            if (days <= 2) return 80;
            if (days <= 3) return 60;
            if (days <= 5) return 40;
            if (days <= 7) return 25;
            if (days <= 15) return 10;
            return 0;
        }

        const dateText = (job.postedDate || job.postedStr || job.postedAgo || job.posted || job.jobAge || job.created_at || job.date || "").toString().toLowerCase().trim();

        if (!dateText) return 0;

        // 0–24h: "just posted", "today", "just now", "moments ago", "hours ago", "0d", "1d ago", "1 day ago", "24h", "new"
        if (/just posted|today|just now|moments ago|\bhours? ago|\b\d+\s*mins?|\b\d+\s*minutes?|0d|1d ago|1 day ago|24h|24\s*hours?|\bnew\b/i.test(dateText)) {
            return 100;
        }

        // 24–48h: "2 days ago", "2d ago", "48h", "2 days"
        if (/2\s*days? ago|2d ago|48h|2\s*days?/i.test(dateText)) {
            return 80;
        }

        // 48–72h: "3 days ago", "3d ago", "72h", "3 days"
        if (/3\s*days? ago|3d ago|72h|3\s*days?/i.test(dateText)) {
            return 60;
        }

        // 3–5 days: "4 days", "5 days", "4d", "5d"
        if (/[4-5]\s*days?|[4-5]d/i.test(dateText)) {
            return 40;
        }

        // 5–7 days: "6 days", "7 days", "6d", "7d", "1 week"
        if (/[6-7]\s*days?|[6-7]d|1\s*week/i.test(dateText)) {
            return 25;
        }

        // 7–15 days: "8 days"..."15 days", "8d"..."15d", "2 weeks"
        if (/(?:8|9|1[0-5])\s*days?|(?:8|9|1[0-5])d|2\s*weeks/i.test(dateText)) {
            return 10;
        }

        return 0;
    }

    /**
     * Calculate experience ranking bonus score.
     * Priority: 2–4 (+100) > 1–3 (+80) > 2–5 (+70) > 3–5 (+60) > 1–4 (+50) > 3–6 (+40) > 0–3 (+20) > 4–6 (+10) > others (0)
     * @param {string} experienceStr 
     * @returns {number} YOE bonus score
     */
    calculateYoeBonus(experienceStr = "") {
        const parsed = parseExperience(experienceStr);
        if (parsed.isUnknown) return 0;

        const { min, max } = parsed;

        if (min === 2 && max === 4) return 100;
        if (min === 1 && max === 3) return 80;
        if (min === 2 && max === 5) return 70;
        if (min === 3 && max === 5) return 60;
        if (min === 1 && max === 4) return 50;
        if (min === 3 && max === 6) return 40;
        if (min === 0 && max === 3) return 20;
        if (min === 4 && max === 6) return 10;

        return 0;
    }

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

        // 1. Mandatory Exclusions & Eligibility Checks
        if (this.isSreRole(title)) {
            return {
                rankScore: 0,
                isEligible: false,
                ineligibleReason: "SRE_EXCLUDED: Title contains SRE / Site Reliability keyword.",
                breakdown: { applyTypeScore: 0, recency: 0, yoe: 0, location: 0, company: 0, skill: 0, salary: 0, role: 0 },
                selectionReason: "INELIGIBLE (SRE EXCLUDED)"
            };
        }

        const expCheck = checkExperienceEligibility(experienceStr);
        const locCheck = checkLocationEligibility(locationStr, title);

        if (!expCheck.eligible || !locCheck.eligible) {
            return {
                rankScore: 0,
                isEligible: false,
                ineligibleReason: !expCheck.eligible ? expCheck.reason : locCheck.reason,
                breakdown: { applyTypeScore: 0, recency: 0, yoe: 0, location: 0, company: 0, skill: 0, salary: 0, role: 0 },
                selectionReason: "INELIGIBLE"
            };
        }

        // 2. Apply Type Score (Native: +400 | Easy Apply: +250 | External: -100)
        const applyTypeCategory = this.detectApplyType(job);
        let applyTypeScore = 0;
        if (applyTypeCategory === 'NATIVE') applyTypeScore = 400;
        else if (applyTypeCategory === 'EASY_APPLY') applyTypeScore = 250;
        else if (applyTypeCategory === 'EXTERNAL') applyTypeScore = -100;

        // 3. Recency Score (0-24h: +100 | 24-48h: +80 | 48-72h: +60 | 3-5d: +40 | 5-7d: +25 | 7-15d: +10 | Older/Missing: 0)
        const recencyScore = this.calculateRecencyScore(job);

        // 4. Experience Fit Score (YOE Bonus)
        const yoeBonus = this.calculateYoeBonus(experienceStr);

        // 5. Location Score (Bangalore: +30 | Remote: +20 | Other India Hubs: +10)
        let locationScore = 0;
        const locLower = locationStr.toLowerCase();
        if (locLower.includes("bangalore") || locLower.includes("bengaluru")) {
            locationScore = 30;
        } else if (locLower.includes("remote") || locLower.includes("work from home")) {
            locationScore = 20;
        } else if (/hyderabad|pune|chennai|mumbai|gurugram|noida|delhi|kochi|trivandrum/i.test(locLower)) {
            locationScore = 10;
        } else {
            locationScore = 5;
        }

        // 6. Skill Match Score (Max 25 Pts)
        const primarySkills = ["aws", "kubernetes", "terraform", "docker", "ci/cd", "linux"];
        const secondarySkills = ["python", "jenkins", "ansible", "azure", "gcp", "prometheus", "grafana", "github actions"];
        const combinedText = `${titleLower} ${skillsText}`;
        const matchedSkillsList = [];

        let skillScore = 0;
        for (const skill of primarySkills) {
            if (combinedText.includes(skill)) {
                skillScore += 3;
                matchedSkillsList.push(skill.toUpperCase());
            }
        }
        for (const skill of secondarySkills) {
            if (combinedText.includes(skill)) {
                skillScore += 2;
                matchedSkillsList.push(skill.toUpperCase());
            }
        }
        skillScore = Math.min(25, skillScore);
        if (skillScore === 0) skillScore = 5; // Baseline skill match

        // 7. Company Quality Bonus
        let companyScore = 0;
        if (job.isTopCompany || /amazon|google|microsoft|cisco|walmart|accenture|tcs|infosys|wipro|cognizant|ibm|capgemini|oracle|salesforce|vmware|redhat/i.test(company)) {
            companyScore = 15;
        }

        // 8. Salary Availability Score (+10 Pts if disclosed)
        let salaryScore = 0;
        const salStr = (job.salary || "").trim().toLowerCase();
        if (salStr && !salStr.includes("not disclosed") && !salStr.includes("undisclosed") && !salStr.includes("n/a")) {
            salaryScore = 10;
        }

        // 9. Role Relevance Score (Base)
        const directDevOpsRoles = [
            "devops engineer", "cloud engineer", "cloud devops engineer",
            "platform engineer", "infrastructure engineer", "cloud infrastructure engineer",
            "aws engineer", "aws cloud engineer", "aws devops engineer", "azure devops engineer",
            "gcp devops engineer", "cloud platform engineer", "devops platform engineer",
            "build & release engineer", "ci/cd engineer", "kubernetes engineer",
            "mlops engineer", "platform operations engineer"
        ];

        const demotedRoles = [
            "architect", "principal architect", "engineering manager",
            "director", "head of engineering", "frontend", "mobile",
            "data scientist", "qa", "tester", "full stack"
        ];

        let roleScore = 0;
        const isDemoted = demotedRoles.some(r => titleLower.includes(r));
        const isDirect = directDevOpsRoles.some(r => titleLower.includes(r));

        if (isDemoted) {
            roleScore = 10;
        } else if (isDirect) {
            roleScore = 30;
        } else {
            roleScore = 15;
        }

        // Final Total Rank Score Calculation
        const totalScore = applyTypeScore + recencyScore + yoeBonus + locationScore + Math.round(skillScore) + companyScore + salaryScore + roleScore;

        const selectionReason = `Score: ${totalScore} | ApplyType: ${applyTypeCategory} (${applyTypeScore}) | Recency (${recencyScore}) | YOE (${yoeBonus}) | Loc (${locationScore}) | Skills (${Math.round(skillScore)}) | Company (${companyScore}) | Salary (${salaryScore}) | Role (${roleScore})`;

        return {
            rankScore: totalScore,
            isEligible: true,
            breakdown: {
                applyType: applyTypeCategory,
                applyTypeScore,
                recency: recencyScore,
                yoeBonus,
                location: locationScore,
                skill: Math.round(skillScore),
                company: companyScore,
                salary: salaryScore,
                role: roleScore
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


