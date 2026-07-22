const db = require("../database");
const profileManager = require("../profile/ProfileManager");

class CandidateProfile {
    constructor() {
        this.defaults = {
            firstName: "Jawad",
            lastName: "Koroth",
            fullName: "Jawad Koroth",
            email: "", // MUST come from real production data
            phone: "", // MUST come from real production data
            currentLocation: "Bangalore",
            city: "Bangalore",
            state: "Karnataka",
            country: "India",
            currentCompany: "",
            currentJobTitle: "DevOps & Cloud Engineer",
            totalExperience: "5",
            noticePeriod: "1 Month",
            linkedinUrl: "https://linkedin.com/in/jawadkoroth",
            githubUrl: "https://github.com/jawadkoroth",
            portfolioUrl: "https://jawadkoroth.dev",
            educationSchool: "Kannur University",
            educationDegree: "B.Tech in Computer Science",
            educationDiscipline: "Computer Science",
            educationStartYear: "2015",
            educationEndYear: "2019",
            educationYear: "2019",
            skills: "DevOps, Docker, Kubernetes, AWS, Azure, GCP, Linux, Terraform, CI/CD",
            awsExperience: "4",
            azureExperience: "3",
            gcpExperience: "2",
            kubernetesExperience: "4",
            devopsExperience: "5"
        };
    }

    /**
     * Map field alias variants to canonical keys (email, phone, etc.)
     * @param {string} rawKey 
     * @returns {string} Canonical key
     */
    getCanonicalKey(rawKey) {
        if (!rawKey) return "";
        const clean = String(rawKey).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
        if (clean === "email" || clean === "emailaddress" || clean === "realemailaddress") return "email";
        if (clean === "phone" || clean === "phonenumber" || clean === "mobile" || clean === "mobilenumber" || clean === "realphonenumber") return "phone";
        if (clean === "location" || clean === "city" || clean === "currentlocation") return "currentLocation";
        if (clean === "school" || clean === "university" || clean === "educationschool") return "educationSchool";
        if (clean === "degree" || clean === "educationdegree") return "educationDegree";
        if (clean === "discipline" || clean === "fieldofstudy" || clean === "educationdiscipline") return "educationDiscipline";
        return rawKey;
    }

    /**
     * Validate whether a profile value is a real production value or a dummy placeholder
     * @param {string} key 
     * @param {string} value 
     * @returns {boolean}
     */
    isProductionValueValid(key, value) {
        if (!value || typeof value !== "string") return false;
        const str = value.trim().toLowerCase();
        if (!str) return false;

        const canonKey = this.getCanonicalKey(key);

        // Rejected email placeholders
        if (canonKey.includes("email")) {
            if (str.includes("example.com") || str.includes("test.com") || str.includes("dummy.com") || str.includes("placeholder.com")) {
                return false;
            }
            if (!str.includes("@") || !str.includes(".")) return false;
        }

        // Rejected phone placeholders
        if (canonKey.includes("phone") || canonKey.includes("mobile")) {
            const digits = str.replace(/\D/g, "");
            if (digits.includes("9999999999") || digits.includes("0000000000") || digits.includes("123456789") || digits.length < 8) {
                return false;
            }
            if (/^(\d)\1+$/.test(digits)) return false;
        }

        // Rejected generic names/schools
        if (str === "test user" || str === "example user" || str === "example corp" || str === "university" || str === "bachelor's") {
            return false;
        }

        return true;
    }

    /**
     * Get complete candidate profile object with placeholder filtering
     * @returns {Promise<Object>}
     */
    async getProfile() {
        await db.init();
        const rows = await db.all("SELECT key, value FROM candidate_profile").catch(() => []);
        
        const profile = { ...this.defaults };

        // Fall back to profile.json if present
        const jsonProfile = await profileManager.getProfile().catch(() => ({}));
        if (jsonProfile.fullName) profile.fullName = jsonProfile.fullName;
        if (jsonProfile.email && this.isProductionValueValid("email", jsonProfile.email)) profile.email = jsonProfile.email;
        if (jsonProfile.phone && this.isProductionValueValid("phone", jsonProfile.phone)) profile.phone = jsonProfile.phone;
        if (jsonProfile.location) profile.currentLocation = jsonProfile.location;

        for (const row of rows) {
            const canonKey = this.getCanonicalKey(row.key);
            if (this.isProductionValueValid(canonKey, row.value)) {
                profile[canonKey] = row.value;
            }
        }

        // Filter out any default placeholder values
        for (const [k, v] of Object.entries(profile)) {
            if (!this.isProductionValueValid(k, v)) {
                profile[k] = "";
            }
        }

        return profile;
    }

    /**
     * Get specific candidate profile field
     * @param {string} key 
     * @returns {Promise<string|null>}
     */
    async getField(key) {
        const canonKey = this.getCanonicalKey(key);
        const profile = await this.getProfile();
        if (profile[canonKey] && this.isProductionValueValid(canonKey, profile[canonKey])) return profile[canonKey];
        return null;
    }

    /**
     * Delete candidate profile key
     * @param {string} key 
     */
    async deleteField(key) {
        await db.init();
        const canonKey = this.getCanonicalKey(key);
        await db.run("DELETE FROM candidate_profile WHERE key = ? OR key = ?", [canonKey, key]);
    }

    /**
     * Get all candidate profile rows directly from database
     * @returns {Promise<Array<{ key: string, value: string, category: string, updated_at: string }>>}
     */
    async getAllRawFields() {
        await db.init();
        return db.all("SELECT key, value, category, updated_at FROM candidate_profile ORDER BY key ASC").catch(() => []);
    }

    /**
     * Update candidate profile key-value entries
     * @param {Object} updates 
     */
    async updateProfile(updates) {
        await db.init();
        for (const [key, value] of Object.entries(updates)) {
            const canonKey = this.getCanonicalKey(key);
            const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);
            await db.run(
                `INSERT INTO candidate_profile (key, value, updated_at) 
                 VALUES (?, ?, CURRENT_TIMESTAMP) 
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
                [canonKey, valStr]
            );
        }
    }

    /**
     * Run Pre-Live Profile Readiness Check
     * @returns {Promise<{ isReady: boolean, missingRequiredFields: string[] }>}
     */
    async checkPreLiveProfileReadiness() {
        const profile = await this.getProfile();
        const required = [
            { key: "firstName", label: "First Name" },
            { key: "lastName", label: "Last Name" },
            { key: "email", label: "Real Email Address" },
            { key: "phone", label: "Real Phone Number" },
            { key: "currentLocation", label: "Current City/Location" },
            { key: "country", label: "Country" },
            { key: "linkedinUrl", label: "LinkedIn Profile URL" },
            { key: "educationSchool", label: "Education Institution/School" },
            { key: "educationDegree", label: "Degree" },
            { key: "educationDiscipline", label: "Field of Study/Discipline" },
            { key: "educationStartYear", label: "Education Start Year" },
            { key: "educationEndYear", label: "Education End/Graduation Year" }
        ];

        const missing = [];
        for (const item of required) {
            const val = profile[item.key];
            if (!val || !this.isProductionValueValid(item.key, val)) {
                missing.push(item.label);
            }
        }

        return {
            isReady: missing.length === 0,
            missingRequiredFields: missing
        };
    }

    /**
     * Get sanitized profile status (YES/NO without exposing PII in logs)
     * @returns {Promise<{ emailPresent: boolean, emailIsPlaceholder: boolean, phonePresent: boolean, phoneIsPlaceholder: boolean }>}
     */
    async getSanitizedProfileStatus() {
        await db.init();
        const profile = await this.getProfile();
        const emailVal = profile.email || "";
        const phoneVal = profile.phone || "";

        return {
            emailPresent: Boolean(emailVal && emailVal.trim().length > 0),
            emailIsPlaceholder: emailVal ? !this.isProductionValueValid("email", emailVal) : false,
            phonePresent: Boolean(phoneVal && phoneVal.trim().length > 0),
            phoneIsPlaceholder: phoneVal ? !this.isProductionValueValid("phone", phoneVal) : false
        };
    }
}

module.exports = new CandidateProfile();
