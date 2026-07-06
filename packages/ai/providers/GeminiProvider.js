const BaseProvider = require("./BaseProvider");
const axios = require("axios");
const logger = require("../../logger");

class GeminiProvider extends BaseProvider {
    /**
     * @param {string} apiKey 
     * @param {string} model 
     */
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey;
        this.model = model || "gemini-2.5-flash";
    }

    async parseCommand(commandText, systemPrompt) {
        logger.automation.info(`Executing AI completion via Google Gemini API (${this.model}).`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        
        const response = await axios.post(
            url,
            {
                contents: [
                    {
                        parts: [
                            { text: `${systemPrompt}\n\nUser request: ${commandText}` }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            },
            {
                headers: { "Content-Type": "application/json" },
                timeout: 15000
            }
        );

        let content = response.data.candidates[0].content.parts[0].text.trim();
        if (content.startsWith("```")) {
            content = content.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }
        return JSON.parse(content);
    }
}

module.exports = GeminiProvider;
