const fs = require("fs-extra");
const path = require("path");

class NaukriApiProbe {
    constructor(storageStatePath) {
        this.storageStatePath = storageStatePath || path.join(process.cwd(), "sessions", "naukri", "storageState.json");
        this.baseUrl = "https://www.naukri.com";
        this.sessionData = null;
        this.cookiesHeader = "";
        this.bearerToken = null;
        this.lastNkparam = null;
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
            "appid": extra.appid || (requireAuth ? "105" : "121"),
            "clientid": "d3skt0p",
            "systemid": "Naukri",
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            "sec-ch-ua-platform": "\"Linux\"",
            "x-requested-with": "XMLHttpRequest",
            "cookie": this.cookiesHeader
        };

        if (this.bearerToken) {
            headers["authorization"] = this.bearerToken.startsWith("Bearer ") ? this.bearerToken : `Bearer ${this.bearerToken}`;
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
        const url = `${this.baseUrl}/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/dashboard?systemId=Naukri`;
        const headers = this._buildHeaders({ appid: "105" }, true);
        return await this._fetchJson(url, { method: "GET", headers });
    }

    // TEST B: Job Search READ
    async searchJobs(keyword, location = "Bangalore", experience = 2, nkparam = null) {
        const searchPath = `${keyword.toLowerCase().replace(/\s+/g, "-")}-jobs-in-${location.toLowerCase()}`;
        const url = `${this.baseUrl}/jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=cloudSearch&keyword=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&experience=${experience}&seoKey=${searchPath}&pageNo=1`;

        const extraHeaders = {
            appid: "121",
            referer: `https://www.naukri.com/${searchPath}`
        };

        if (nkparam || this.lastNkparam) {
            extraHeaders["nkparam"] = nkparam || this.lastNkparam;
        }

        const headers = this._buildHeaders(extraHeaders, true);
        return await this._fetchJson(url, { method: "GET", headers });
    }

    // TEST C: Job Details READ
    async getJobDetails(jobId) {
        const url = `${this.baseUrl}/jobapi/v1/job/${jobId}`;
        const headers = this._buildHeaders({ appid: "105" }, true);
        return await this._fetchJson(url, { method: "GET", headers });
    }

    // TEST D: Same-Value Profile Headline Update Test
    async updateProfileHeadline(headlineText) {
        const url = `${this.baseUrl}/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles`;
        const headers = this._buildHeaders({
            appid: "105",
            "content-type": "application/json"
        }, true);

        const payload = {
            profile: {
                resumeHeadline: {
                    headline: headlineText
                }
            }
        };

        return await this._fetchJson(url, {
            method: "PUT",
            headers,
            body: JSON.stringify(payload)
        });
    }
}

module.exports = NaukriApiProbe;
