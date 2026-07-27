# Naukri API Transport Feasibility Study & NopeRi Reference Analysis

## Executive Summary
This document analyzes the API-based transport architecture for Naukri.com inspired by the open-source reference project [NopeRi](https://github.com/Traverser25/NopeRi). The objective is to evaluate whether OpenClaw can reliably perform candidate profile verification, job discovery, job detail extraction, and profile refreshes via direct HTTPS API endpoints using existing authenticated session cookies/tokens, bypassing browser DOM rendering overhead and Playwright flakiness.

---

## NopeRi Architectural Capability Matrix

| Capability | Endpoints & Mechanism | Auth Requirement | Required Headers | OpenClaw Equivalence | Architectural Suitability |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication / Session** | `POST /central-login-services/v1/login` | Email/Password | `appid: 105`, `clientid: d3skt0p`, `systemid: jobseeker` | `storageState.json` (Playwright manual login session) | **Reuse OpenClaw session** (Never automate credentials or bypass MFA) |
| **Profile Read** | `GET /cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/dashboard` | Bearer Token / Cookie | `authorization: Bearer <nauk_at>`, `systemid: Naukri` | Playwright DOM `mnjuser/profile` | **High** (Direct JSON payload, zero DOM dependency) |
| **Profile Update (Headline)** | `PUT /cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles` | Bearer Token / Cookie | `authorization: Bearer <nauk_at>`, `systemid: Naukri`, `content-type: application/json` | Playwright DOM form edit | **High** (Same-value save for profile timestamp refresh) |
| **Job Discovery / Search** | `GET /jobapi/v3/search` | `nkparam` Header + Optional Auth | `nkparam: <token>`, `appid: 105`, `systemid: N/A` | Playwright search card scraping | **High** (Direct structured JSON output with exact job fields) |
| **Job Details Read** | `GET /jobapi/v1/job/<job_id>` | Auth Optional / Cookie | `appid: 105`, `systemid: jobseeker` | Playwright job page DOM | **High** (Clean JSON metadata, questionnaire flags) |
| **One-Click Application** | `POST /jobapi/v1/job/apply` | Bearer Token + Cookies | `authorization: Bearer <nauk_at>`, `systemid: Naukri` | Playwright apply button click | **Requires Evaluation** (Inspect only in probe, NO live applications during testing) |

---

## Key Authentication & Security Findings

1. **Bearer Token vs Cookies**:
   - Naukri API endpoints require a `Bearer <token>` authorization header (derived from the short-lived `nauk_at` session cookie) as well as valid session cookies (`nauk_rt`, `nauk_sid`).
   - Pure API requests without a fresh `nauk_at` token return **HTTP 401 Unauthorized (`SESSION_EXPIRED`)**.

2. **`nkparam` Header Requirements**:
   - The job search API (`/jobapi/v3/search`) enforces an `nkparam` signed request header.
   - Without a valid `nkparam` and header structure (`appid: 121`, `clientid: d3skt0p`, `systemid: Naukri`), `/jobapi/v3/search` returns **HTTP 406 Not Acceptable**.
   - `nkparam` is generated inside Naukri's obfuscated frontend JS using RSA/timestamp encryption. Pure HTTP API transport without browser execution cannot dynamically sign requests when `nkparam` rotates.

3. **Cloud Datacenter IP Restrictions & Akamai Behavior**:
   - Empirical testing on Oracle VM (`140.245.212.88`) demonstrated that rapid or back-to-back Playwright script executions trigger Akamai Edge Security (`errors.edgesuite.net`) IP rate-limiting, resulting in **HTTP 403 Access Denied** across both candidate pages and search routes.
   - When requests are spaced out by standard operational timer intervals (e.g. 09:30 AM & 02:00 PM IST), Playwright transport executes cleanly without triggering 403 blocks.
   - Direct HTTPS API endpoints do NOT bypass Akamai IP reputation checks and add requirement burdens (`nkparam` RSA signatures and `nauk_at` token refreshes).

---

## Final Feasibility Conclusion
- **Primary Transport**: Retain the existing **Playwright Headless Transport** on Oracle VM with Candidate Dashboard entrypoint (`mnjuser/homepage`), multi-selector fallbacks, token refresh persistence, and failure diagnostic logging.
- **API Transport Classification**: **`NAUKRI_API_AUTH_INCOMPATIBLE`** (Pure API transport is incompatible for unattended operation due to mandatory client-side `nkparam` RSA signature generation and short-lived `nauk_at` Bearer token expiration).
- **Oracle IP Assessment**: **SUSPECT / INTERMITTENT** under high-frequency testing, **STABLE** when respecting natural operational timer schedules.

