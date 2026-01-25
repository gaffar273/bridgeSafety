require('dotenv').config();
const { ChatVertexAI } = require("@langchain/google-vertexai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { getRoute, getSecurityStats, calculateRiskScore } = require('./tools');

// Initialize Vertex AI (Gemini 2.5 Pro)
const model = new ChatVertexAI({
    model: "gemini-2.5-pro",
    temperature: 0.1,
    maxOutputTokens: 8192,
    location: process.env.LOCATION
});

// --- STEP 1: PARSE NATURAL LANGUAGE ---
async function parseIntent(userInput) {
    const prompt = `
    You are a Blockchain Transaction Parser.
    Extract the following fields from the user's request.
    
    USER REQUEST: "${userInput}"
    
    OUTPUT SCHEMA (JSON):
    {
      "fromChain": "chain key (eth, arb, opt, base, bsc, pol, sol, etc)",
      "toChain": "chain key",
      "token": "symbol or 0x address",
      "amount": "raw integer amount (convert 1k to 1000, etc)"
    }
    
    NOTE: If decimals aren't specified, assume standard 6 (USDC) or 18 (ETH). 
    For this demo, if user says "5000", output "5000000000" (assuming 6 decimals for stables) or strictly follow user input if specific.
  `;

    const res = await model.invoke([new HumanMessage(prompt)]);
    try {
        const clean = res.content.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(clean);
    } catch (e) {
        return null;
    }
}

// --- STEP 2: MAIN AGENT LOOP ---
async function runAgent(userInput) {
    console.log(`\n💬 Processing: "${userInput}"`);

    // A. Understand Intent
    const intent = await parseIntent(userInput);
    if (!intent || !intent.fromChain || !intent.toChain) {
        console.log(" Could not understand the request. Please specify From, To, and Amount.");
        return;
    }
    console.log(`✅ Intent: Transfer ${intent.amount} ${intent.token} (${intent.fromChain} -> ${intent.toChain})`);

    // B. Find Route
    console.log("🔍 Finding best bridge route...");
    const route = await getRoute(intent.fromChain, intent.toChain, intent.token, intent.amount);

    if (!route.success) {
        console.log(` Route Failed: ${route.error}`);
        return;
    }
    console.log(`-> Selected Bridge: ${route.bridgeName.toUpperCase()} (Est. Gas: $${route.gasCostUSD})`);

    // C. Check Security
    console.log(`  Running security audit on ${route.bridgeName}...`);
    const security = await getSecurityStats(route.bridgeName);

    // D. Final Reasoning
    // D. Final Reasoning (Deterministic)
    console.log(" Calculating risk score...");
    const riskAnalysis = calculateRiskScore(security);

    const advisorPrompt = `
    You are a Bridge Safety Officer. 
    
    1. Technical Route: ${JSON.stringify(route)}
    2. Security Context: ${JSON.stringify(security)}
    3. Risk Analysis: ${JSON.stringify(riskAnalysis)}

    Your Job:
    - Briefly explain the verdict based on the risk analysis.
    - Be concise and professional.
    
    Output JSON: { "explanation": "string" }
  `;

    console.log("📝 Generating report summary...");
    const finalRes = await model.invoke([new HumanMessage(advisorPrompt)]);

    // Output result
    try {
        const aiOutput = JSON.parse(finalRes.content.replace(/```json/g, "").replace(/```/g, "").trim());
        return {
            verdict: riskAnalysis.verdict,
            score: riskAnalysis.score,
            explanation: aiOutput.explanation || riskAnalysis.explanation
        };
    } catch (e) {
        console.log("AI Summary Failed, using default explanation.");
        return {
            verdict: riskAnalysis.verdict,
            score: riskAnalysis.score,
            explanation: riskAnalysis.explanation
        };
    }
}

module.exports = { runAgent };