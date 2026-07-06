require("dotenv").config({
    path: require("path").join(__dirname, "..", ".env")
});

console.log("Email:", process.env.NAUKRI_EMAIL || "Not Set");

console.log(
    "Password:",
    process.env.NAUKRI_PASSWORD ? "Loaded" : "Missing"
);

console.log(
    "OpenRouter:",
    process.env.OPENROUTER_API_KEY ? "Loaded" : "Missing"
);

console.log(
    "Telegram:",
    process.env.TELEGRAM_BOT_TOKEN ? "Loaded" : "Missing"
);
