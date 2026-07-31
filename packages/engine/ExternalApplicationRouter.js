const greenhouseAdapter = require("./adapters/GreenhouseAdapter");
const leverAdapter = require("./adapters/LeverAdapter");
const smartRecruitersAdapter = require("./adapters/SmartRecruitersAdapter");
const workdayAdapter = require("./adapters/WorkdayAdapter");
const ashbyAdapter = require("./adapters/AshbyAdapter");
const successFactorsAdapter = require("./adapters/SuccessFactorsAdapter");
const oracleRecruitingAdapter = require("./adapters/OracleRecruitingAdapter");
const genericFormAdapter = require("./adapters/GenericFormAdapter");

class ExternalApplicationRouter {
    /**
     * Get appropriate ATS adapter for classified ATS string
     * @param {string} ats 
     * @returns {import('./adapters/BaseATSAdapter')}
     */
    getAdapter(ats = "") {
        const atsKey = String(ats || "").toUpperCase();
        switch (atsKey) {
            case "GREENHOUSE":
                return greenhouseAdapter;
            case "LEVER":
                return leverAdapter;
            case "SMARTRECRUITERS":
                return smartRecruitersAdapter;
            case "WORKDAY":
                return workdayAdapter;
            case "ASHBY":
                return ashbyAdapter;
            case "SUCCESSFACTORS":
                return successFactorsAdapter;
            case "ORACLE_RECRUITING":
                return oracleRecruitingAdapter;
            case "COMPANY_SITE":
            case "UNKNOWN_EXTERNAL":
            default:
                return genericFormAdapter;
        }
    }
}

module.exports = new ExternalApplicationRouter();
