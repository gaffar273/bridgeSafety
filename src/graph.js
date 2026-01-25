require('dotenv').config();
const { StateGraph, MessagesAnnotation } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { ChatVertexAI } = require("@langchain/google-vertexai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { DynamicStructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const { getRoute, getBridgeOptions, getSecurityStats, calculateRiskScore, getTokenDetails, getSupportedBridges } = require("./tools"); // Added getTokenDetails

// --- 1. CONFIGURATION ---
const model = new ChatVertexAI({
    model: "gemini-2.5-flash",
    temperature: 0.1,
    maxOutputTokens: 8192,
    location: process.env.LOCATION
});

// --- 2. TOOL WRAPPERS ---

const routeTool = new DynamicStructuredTool({
    name: "get_bridge_route",
    description: "Finds the best technical route (bridge) for a token transfer between chains.",
    schema: z.object({
        fromChain: z.string().describe("Source chain (e.g., 'eth', 'base', 'arb')"),
        toChain: z.string().describe("Destination chain"),
        fromToken: z.string().describe("Source Token Symbol OR Address (if known). e.g. 'USDC' or '0x...'"),
        toToken: z.string().describe("Destination Token Symbol (e.g. 'USDC'). Do NOT use address here unless sure."),
        amount: z.string().describe("Amount in ATOMIC units (e.g. 1000000 for 1 USDC). You MUST calculate this."),
    }),
    func: async ({ fromChain, toChain, fromToken, toToken, amount }) => {
        const res = await getRoute(fromChain, toChain, fromToken, amount, toToken);
        return JSON.stringify(res);
    }
});

const securityTool = new DynamicStructuredTool({
    name: "get_security_stats",
    description: "Gets security stats (TVL, hacks) for a specific bridge protocol.",
    schema: z.object({
        bridgeName: z.string().describe("Name of the bridge (e.g., 'stargate', 'across')"),
    }),
    func: async ({ bridgeName }) => {
        const stats = await getSecurityStats(bridgeName);
        // Also perform the risk calculation automatically here to assist the agent
        const risk = calculateRiskScore(stats);
        return JSON.stringify({ ...stats, risk_analysis: risk });
    }
});

const tokenTool = new DynamicStructuredTool({
    name: "get_token_details",
    description: "Look up technical details (Address, Decimals) for a token on a specific chain.",
    schema: z.object({
        chain: z.string().describe("Chain name or ID (e.g. 'base', 'arb', '1')"),
        symbol: z.string().describe("Token symbol (e.g. 'USDC', 'USDT')"),
    }),
    func: async ({ chain, symbol }) => {
        const res = await getTokenDetails(chain, symbol);
        return JSON.stringify(res);
    }
});

const comparisonTool = new DynamicStructuredTool({
    name: "get_bridge_options",
    description: "Fetch and Compare multiple bridge routes (Top 3) with their Risk Scores.",
    schema: z.object({
        fromChain: z.string(),
        toChain: z.string(),
        fromToken: z.string().describe("Source Token Address"),
        toToken: z.string().describe("Destination Token Symbol"),
        amount: z.string().describe("Atomic Amount"),
    }),
    func: async ({ fromChain, toChain, fromToken, toToken, amount }) => {
        const res = await getBridgeOptions(fromChain, toChain, fromToken, amount, toToken);
        return JSON.stringify(res);
    }
});

const listBridgesTool = new DynamicStructuredTool({
    name: "get_supported_bridges",
    description: "Get a list of all bridging protocols supported by the system.",
    schema: z.object({}),
    func: async () => {
        const res = await getSupportedBridges();
        return JSON.stringify(res);
    }
});

const tools = [routeTool, securityTool, tokenTool, comparisonTool, listBridgesTool];
const toolNode = new ToolNode(tools);

// --- 3. AGENT NODE ---

const modelWithTools = model.bindTools(tools);

async function callModel(state) {
    const messages = state.messages;

    // Add a system message if it's the first turn, or rely on the agent's persona.
    // Let's prepend a system message effectively by ensuring the model knows its role.
    const systemPrompt = new SystemMessage(`
    You are a Bridge Safety Officer. Your goal is to help users transfer funds safely.
    
    WORKFLOW:
    1. Identify tokens. Calling 'get_bridge_options' handles most resolution automatically!
    2. CALL 'get_bridge_options' to get a comparison of the top 3 routes.
       - The tool returns: 'protocolFeeUSD', 'aggregatorFeeUSD', 'executionDuration' (formatted), and 'riskScore'.
    
    3. **PRESENTATION** (The most important part):
       - Present a table of choices.
       - **Columns**: | Bridge | Net Output | Bridge Fee | Li.Fi Fee | Risk (TVL) | Est. Duration |
       - **Li.Fi Fee Rule**: If 'aggregatorFeeUSD' is $0.00, LEAVE IT EMPTY or write "-". Do NOT show "$0.00" unless relevant.
       - **Bridge Fee**: This is the 'protocolFeeUSD'. *Note*: This includes LP fees + Destination Gas/Relayer fees (total protocol cost).
       - **Risk (TVL)**: Show the verdict AND the TVL from the tool. Example: "SECURE ($500M)". 
         - Do NOT try to convert seconds yourself, the tool does it.
       - **Gas Cost**: Mention the Gas Cost USD in text below the table (it's usually separate).
       - **Fee Breakdown**: If 'protocolFeeUSD' is significant (> $1), PROACTIVELY explain it using 'feeDetails'.
         - Example: "Note: The $3.75 Bridge Fee includes $1.25 LP Fee and $2.49 Relayer Fee."
         - This is CRITICAL for user trust when fees seem high.
       - **Money Saving Tip**: If 'aggregatorFeeUSD' > 0, tell the user: 
         - "💡 **Tip**: You can save the **$2.50 Li.Fi Fee** by using the [Bridge Name] official site directly."
    
    4. Provide a final recommendation (SECURE, CAUTION, or DANGER).
       - If a route is "DANGER" (Risk Score < 40), warn user explicitly.
    
    Be helpful, conversational, and strict about security.
    `);

    // If history doesn't start with system, we could add it, but binding it to the model 
    // or just sending it every time is easier. 
    // For LangGraph, usually we just let the conversation flow.
    // Let's prepend it to the history for the model call only.

    const response = await modelWithTools.invoke([systemPrompt, ...messages]);
    return { messages: [response] };
}

// --- 4. GRAPH DEFINITION ---

function shouldContinue(state) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];

    if (lastMessage.tool_calls?.length) {
        return "tools";
    }
    return "__end__";
}

const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

// Compile the graph
const graph = workflow.compile();

module.exports = { graph };
