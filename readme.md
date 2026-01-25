# Bridge Safety Agent

A CLI-based agent that helps users find the safest and most efficient cross-chain bridging routes. It aggregates data from **Li.Fi**, **DefiLlama**, and **L2Beat** to provide transparent fee breakdowns, risk assessments, and money-saving tips.

## 🚀 Key Features

### 1. Transparent Fee Breakdown 💸
Unlike standard interfaces that hide costs, the Agent explicitly breaks down fees:
-   **Bridge Fee**: The protocol's fee (Liquidity Provider Fee + Relayer/Gas Fee).
-   **Li.Fi Fee**: The aggregator's service fee.
-   **Transparency**: If the Bridge Fee seems high, the Agent explains *why* (e.g., "Includes $2.50 Relayer Gas Fee").

### 2. Risk Assessment with Real-Time TVL 🛡️
-   **Dynamic TVL**: Fetches the latest Total Value Locked from **DefiLlama** to gauge protocol maturity.
-   **Risk Scoring**:
    -   **SECURE**: High TVL, audited, no recent hacks.
    -   **CAUTION**: Lower TVL or minor concerns.
    -   **DANGER**: Recently hacked or very low liquidity (<$10M).
-   **Zero-TVL Handling**: Correctly marks protocols without public TVL data as "N/A" rather than $0.

### 3. Smart Duration Estimates ⏱️
-   Converts raw technical execution times into human-readable formats (e.g., "~5 mins", "30 secs").

### 4. Money-Saving Tips 💡
-   **Aggregator Bypass**: If an aggregator fee is detected, the Agent proactively tips the user: *"You can save $X by using the bridge's official site directly."*

## 📦 Installation & Usage
```bash
npm install
npm start
```
**Example Queries:**
-   "Bridge 1000 USDT from Arbitrum to Optimism"
-   "Send 500 USDC from Base to Linea"

---

## 🛠️ Technical Architecture

### 1. Folder Structure 📂
```text
blockC/bridgeSafety/
├── src/
│   ├── cli.js           # CLI Entry Point. Handles user input/output loop.
│   ├── graph.js         # LangGraph Definition. Defines the Agent's brain, states, and prompt.
│   ├── tools.js         # Tool Implementations. API logic for Li.Fi and DefiLlama.
│   ├── agent.js         # (Legacy/Helper) Base agent configuration.
│   └── index.js         # Module exports.
├── .env                 # Configuration.
├── README.md            # Documentation.
└── package.json         # Dependencies.
```

### 2. Technology Stack 💻
-   **LangGraph**: For stateful, cyclic agent workflows (Planning -> Tool Call -> Reasoning).
-   **LangChain**: For tool binding and model interaction (Vertex AI / Gemini).
-   **Node.js**: Execution environment.
-   **Axios**: For HTTP requests.
-   **Chalk**: For colorful CLI output.

### 3. APIs & Endpoints 🌐

#### A. Li.Fi (Aggregator API)
Used for fetching routes, estimating fees, and getting technical duration.
-   `GET /v1/quote`: Fetch simple 1-to-1 route data.
-   `POST /v1/advanced/routes`: Fetch multiple route options for comparison.
-   `GET /v1/token`: Resolve token symbols to addresses (e.g., `USDT` -> `0xFd08...`).
-   `GET /v1/tools`: List supported bridges.

#### B. DefiLlama (Security Data)
Used for risk assessment, TVL (Total Value Locked), and Hack history.
-   `GET /protocols`: Fetches **ALL** protocols (~4MB) to perform robust fuzzy matching on bridge names.
-   `GET /protocol/{slug}`: Fetches detailed TVL history for a specific bridge.
-   `GET /hacks`: Checks if the protocol has been exploited recently.

### 4. Key Approaches & Logic 🧠

#### Transparency First (The "Fee Split")
Standard aggregators often bundle fees. This agent splits them:
-   **Protocol Fee**: The unavoidable fee paid to the bridge/LPs/Relayers.
-   **Aggregator Fee**: The service fee paid to Li.Fi.
-   **Logic**: If `Aggregator Fee > 0`, the agent proactively suggests: *"Use the bridge directly to save money."*

#### Robust Security Matching
-   **Problem**: API Names mismatch (e.g., Li.Fi calls it "stargateV2Bus", DefiLlama calls it "stargate").
-   **Solution**: `tools.js` implements a fuzzy search that:
    1.  Checks exact matches.
    2.  Checks substring matches.
    3.  Strips version suffixes (e.g., "v2") to find the parent protocol's security data.

#### Dynamic Token Resolution
-   Handles input flexibility (Symbols vs Addresses).
-   Uses fallback lists for common tokens (USDT/USDC) if API resolution fails.
