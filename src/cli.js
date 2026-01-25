require('dotenv').config();
const readline = require('readline');
const { graph } = require('./graph');
const { HumanMessage } = require("@langchain/core/messages");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const threadId = "cli-session-" + Date.now();
const config = { configurable: { thread_id: threadId } };

// Memory for the session (LangGraph graph invocation usually takes full state if no checkpointer, 
// OR input messages which are appended. 
// "graph" from ./graph.js was compiled WITHOUT checkpointer in the previous step's code.
// *Correction*: In the previous step for `server.js`, I noted that without a checkpointer, we must pass full history.
// However, `graph.js` as implemented uses `MessagesAnnotation` which expects a list of messages. 
// If we invoke it with JUST the new message, and the graph doesn't have persistence, it might not see history.
// BUT `StateGraph` with `addConditionalEdges` typically returns the NEW state. 
// So we need to accumulate messages manually in this CLI script if the graph is stateless.
// Let's do that: `currentState` variable.

let currentMessages = [];

console.log("\n  Bridge Safety Agent (CLI)");
console.log("-----------------------------------");
console.log("Type your request. (e.g., 'send 100 usdc from base to arbitrum')");
console.log("Type 'exit' to quit.\n");

// --- SPINNER LOGIC ---
let spinnerInterval;
function startSpinner(msg = "Thinking") {
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    process.stdout.write(`\r${chars[0]} ${msg}...`); // Initial write

    spinnerInterval = setInterval(() => {
        i = (i + 1) % chars.length;
        process.stdout.write(`\r${chars[i]} ${msg}...`);
    }, 80);
}

function stopSpinner() {
    clearInterval(spinnerInterval);
    process.stdout.write('\r\x1b[K'); // Clear line
}

function ask() {
    rl.question('You: ', async (input) => {
        if (input.toLowerCase() === 'exit') {
            rl.close();
            return;
        }

        try {
            // Append user message
            const userMsg = new HumanMessage(input);
            currentMessages.push(userMsg);

            // Start the spinner
            startSpinner();

            // Use stream() to get updates as the agent works
            let finalState = { messages: [] };

            // We pass the full history (currentMessages) + the new user message (userMsg) implicitly?
            // Wait, currentMessages ALREADY contains userMsg from line 59.
            // So we invoke with { messages: currentMessages }

            const stream = await graph.stream({ messages: currentMessages }, config);

            for await (const chunk of stream) {
                // chunk is usually keyed by the node name, e.g. { agent: { messages: [...] } }
                for (const [node, update] of Object.entries(chunk)) {
                    // Update our final state tracking with the latest chunk's messages
                    // 'update.messages' is usually just the new messages added in that step.
                    // We can rely on the fact that we will get the final state at the end or reconstruct it.
                    // For simply displaying the spinner, we check the chunk.

                    if (node === 'agent') {
                        // Check if the agent wants to call a tool
                        const messages = update.messages;
                        const lastMsg = messages[messages.length - 1];

                        if (lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
                            const tc = lastMsg.tool_calls[0];
                            let statusMsg = "Thinking";
                            if (tc.name === 'get_token_details') statusMsg = "Finding Tokens";
                            else if (tc.name === 'get_bridge_options') statusMsg = "Scanning Bridges";
                            else if (tc.name === 'get_security_stats') statusMsg = "Checking Security";
                            else if (tc.name === 'get_route') statusMsg = "Calculating Route";

                            stopSpinner();
                            startSpinner(statusMsg);
                        }
                    } else if (node === 'tools') {
                        // Tools finished
                        stopSpinner();
                        startSpinner("Analyzing Data");
                    }

                    // We need to keep our `currentMessages` in sync.
                    // If `chunk` returns the DELTA messages (which it usually does for StateGraph),
                    // we should append them. 
                    // However, `update.messages` might be an array of the *new* messages?
                    // Let's safe bet: Get the full state at the end if possible.
                    // But `stream` yields partials.
                    // Let's accumulate `finalState`.
                    if (update.messages) {
                        finalState.messages.push(...update.messages);
                    }
                }
            }

            stopSpinner();

            // Synchronize our main history
            currentMessages.push(...finalState.messages);

            // Get the last message (Assistant's response)
            const lastMsg = currentMessages[currentMessages.length - 1];

            console.log(`\nAgent: ${lastMsg.content}\n`);

        } catch (error) {
            stopSpinner(); // Ensure spinner stops on error
            console.error("\nError:", error.message, "\n");
        }

        ask();
    });
}

ask();
