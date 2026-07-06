module.exports = {

    browser: {
        headless: true,
        timeout: 60000
    },

    urls: {

        naukri: "https://www.naukri.com",

        linkedin: "https://www.linkedin.com",

        foundit: "https://www.foundit.in",

        hirist: "https://www.hirist.tech"

    },

    schedule: {

        naukriMorning: "09:30",

        naukriEvening: "14:00",

        applyJobs: "10:00"

    },

    screenshots: true,

    retries: 3

};
