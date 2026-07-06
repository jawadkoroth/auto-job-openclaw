const path = require("path");
const fs = require("fs-extra");

class ProfileManager {
    constructor() {
        this.profilePath = path.join(process.cwd(), "profile.json");
        this.defaultProfile = {
            fullName: "Jawad Koroth",
            email: "jawad.koroth@example.com",
            phone: "+919999999999",
            location: "Bangalore",
            headline: "DevOps Engineer | Cloud & Automation Specialist | Docker | AWS",
            summary: "Results-driven Software & DevOps Engineer specializing in CI/CD pipeline automation, Docker containerization, AWS cloud migrations, and automated browser testing workflows.",
            skills: ["Docker", "Kubernetes", "AWS", "Linux", "Node.js", "Python", "CI/CD"],
            experienceYears: 5
        };
    }

    /**
     * Fetch user profile data, reading from local profile.json if present
     * @returns {Promise<Object>} User profile schema object
     */
    async getProfile() {
        if (await fs.pathExists(this.profilePath)) {
            try {
                return await fs.readJson(this.profilePath);
            } catch (e) {
                // Fall back to default
            }
        }
        return this.defaultProfile;
    }

    /**
     * Save/Update user profile fields
     * @param {Object} newProfile 
     */
    async updateProfile(newProfile) {
        await fs.writeJson(this.profilePath, newProfile, { spaces: 2 });
    }
}

module.exports = new ProfileManager();
