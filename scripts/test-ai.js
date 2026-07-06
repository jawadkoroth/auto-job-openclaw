const aiOrchestrator = require("../packages/ai");

(async () => {
    console.log("=== Testing AI Orchestrator Command Translation ===");
    
    const commandPrompts = [
        "Update my Naukri profile",
        "Apply only DevOps jobs in Bangalore on Naukri",
        "Log in to LinkedIn",
        "Search for React developer jobs in Chennai on Foundit"
    ];

    for (const prompt of commandPrompts) {
        console.log(`\nInput: "${prompt}"`);
        const task = await aiOrchestrator.parseCommand(prompt);
        console.log("Output JSON:", JSON.stringify(task, null, 4));
    }
    
    process.exit(0);
})();
