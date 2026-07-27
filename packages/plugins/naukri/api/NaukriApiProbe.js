const fs = require("fs-extra");
const path = require("path");

class NaukriApiProbe {
    constructor(storageStatePath) {
        this.storageStatePath = storageStatePath || path.join(process.cwd(), "sessions", "naukri", "storageState.json");
        this.baseUrl = "https://www.naukri.com";
        this.sessionData = null;
        this.cookiesHeader = "";
        this.bearerToken = null;
    }

    async loadSession() {
        if (!fs.existsSync(this.storageStatePath)) {
            throw new Error(`storageState.json not found at ${this.storageStatePath}`);
        }
        const raw = fs.readJsonSync(this.storageStatePath);
        this.sessionData = raw;

        const validCookies = (raw.cookies || []).filter(c => {
            if (!c.expires || c.expires === -1) return true;
            return (c.expires * 1000) > Date.now();
        });

        this.cookiesHeader = validCookies.map(c => `${c.name}=${c.value}`).join("; ");

        const naukAtCookie = (raw.cookies || []).find(c => c.name === "nauk_at");
        if (naukAtCookie && naukAtCookie.value) {
            this.bearerToken = naukAtCookie.value;
        }

        return {
            totalCookies: (raw.cookies || []).length,
            validCookies: validCookies.length,
            hasBearerToken: Boolean(this.bearerToken)
        };
    }

    _buildHeaders(extra = {}, requireAuth = true) {
        const headers = {
            "accept": "application/json",
            "appid": "105",
            "clientid": "d3skt0p",
            "systemid": requireAuth ? "Naukri" : "jobseeker",
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "x-requested-with": "XMLHttpRequest",
            "cookie": this.cookiesHeader
        };

        if (requireAuth && this.bearerToken) {
            headers["authorization"] = `Bearer ${this.bearerToken}`;
        }

        return { ...headers, ...extra };
    }

    async _fetchJson(url, options = {}) {
        const startTime = Date.now();
        try {
            const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
            const res = await fetchFn(url, options);
            const latency = Date.now() - startTime;
            const status = res.status;
            let data = null;

            try {
                data = await res.json();
            } catch (err) {
                data = null;
            }

            let classification = "UNKNOWN";
            if (status === 200) classification = "API_AUTHENTICATED";
            else if (status === 401) classification = "SESSION_EXPIRED";
            else if (status === 403) classification = "ACCESS_DENIED";
            else if (status === 404 || status === 406) classification = "API_CHANGED";

            return {
                url,
                status,
                latency,
                classification,
                data
            };
        } catch (err) {
            return {
                url,
                status: 0,
                latency: Date.now() - startTime,
                classification: "NETWORK_ERROR",
                error: err.message,
                data: null
            };
        }
    }

    // TEST A: Read Candidate Profile / Dashboard
    async getProfileDashboard() {
        const url = `${this.baseUrl}/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/dashboard`;
        const headers = this._buildHeaders({}, true);
        return await this._fetchJson(url, { method: "GET", headers });
    }

    // TEST B: Job Search READ
    async searchJobs(keyword, location = "Bangalore", experience = 2, nkparam = null) {
        const searchPath = encodeURIComponent(`${keyword.toLowerCase().replace(/\s+/g, "-")}-jobs-in-${location.toLowerCase()}`);
        const url = `${this.baseUrl}/jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=cloudSearch&keyword=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&experience=${experience}&seoKey=${searchPath}&pageNo=1`;

        const extraHeaders = {};
        if (nkparam) {
            extraHeaders["nkparam"] = nkparam;
        }

        const headers = this._buildHeaders(extraHeaders, false);
        return await this._fetchJson(url, { method: "GET", headers });
    }

    // TEST C: Job Details READ
    async getJobDetails(jobId) {
        const url = `${this.baseUrl}/jobapi/v1/job/${jobId}`;
        const headers = this._buildHeaders({}, false);
        return await this._fetchJson(url, { method: "GET", headers });
    }
}

module.exports = NaukriApiProbe;
