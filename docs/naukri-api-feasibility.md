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
   - Naukri API endpoints accept either a `Bearer <token>` authorization header (derived from the `nauk_at` session cookie) or standard session cookies (`nauk_at`, `nauk_rt`, `is_login`, `nauk_sid`).
   - OpenClaw's existing Playwright session in `sessions/naukri/storageState.json` contains valid `nauk_at` and `nauk_rt` cookies which can be cleanly extracted and passed into HTTP request headers (`Axios` or `fetch`/`node-fetch`).

2. **`nkparam` Header Requirements**:
   - The job search API (`/jobapi/v3/search`) enforces an `nkparam` signed request header.
   - Without a valid `nkparam`, `/jobapi/v3/search` returns `HTTP 403 Forbidden`.
   - `nkparam` is generated frontend-side via RSA/timestamp encryption or extracted from active browser requests.

3. **Cloud Datacenter IP Restrictions**:
   - NopeRi documents that Naukri actively inspects IP reputation for datacenter ranges (e.g., Azure, GitHub Actions).
   - This experiment evaluates whether Oracle VM's IP causes API-level 403 blocks or whether Playwright DOM/Akamai bot detection was the primary cause of browser-level instability.

---

## Safety Constraints
- **Zero Live Submissions**: No job applications will be submitted during testing.
- **Zero Profile Modifications**: Profile updates are strictly same-value saves to verify BEFORE === AFTER integrity.
- **Zero Anti-Bot Bypasses**: No proxy rotation, stealth plugins, or security control circumvention.
- **Credential Protection**: Never log cookies, passwords, bearer tokens, or `storageState.json` contents.
