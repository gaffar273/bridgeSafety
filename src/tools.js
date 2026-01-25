const axios = require('axios');

// --- CONSTANTS ---
// Maps user slang to Li.Fi technical keys
const CHAIN_MAP = {
    // Ethereum & L2s
    'eth': 1, 'mainnet': 1, 'ethereum': 1,
    'arb': 42161, 'arbitrum': 42161,
    'opt': 10, 'optimism': 10, 'op': 10,
    'base': 8453,
    'pol': 137, 'polygon': 137, 'matic': 137,
    'zksync': 324, 'era': 324,
    'linea': 59144,
    'blast': 81457,
    // BSC Ecosystem
    'bsc': 56, 'bnb': 56, 'binance': 56,
    'opbnb': 204,
    // Others
    'ava': 43114, 'avalanche': 43114,
    'sol': 'sol', 'solana': 'sol'
};

// Cache for DefiLlama protocols to avoid re-fetching
let allProtocolsCache = null;

// --- HELPER FUNCTIONS ---

function normalizeChain(input) {
    if (!input) return 'eth'; // Default
    if (typeof input === 'number') return input;
    const key = input.toLowerCase().trim();
    return CHAIN_MAP[key] || key;
}

function formatDuration(seconds) {
    if (!seconds) return "Unknown";
    const sec = parseInt(seconds);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h ${remMin}m`;
}

// Fetch and Cache DefiLlama Protocols
async function getProtocolSlug(bridgeName) {
    const searchName = bridgeName.toLowerCase().trim();

    // Explicit overrides for common mismatches
    const overrides = {
        'cbridge': 'celer-network',
        'amarok': 'connext',
        'circle': 'cctp'
    };
    if (overrides[searchName]) return overrides[searchName];

    try {
        if (!allProtocolsCache) {
            // console.log("Fetching full protocol list from DefiLlama...");
            const res = await axios.get('https://api.llama.fi/protocols', { timeout: 15000 });
            allProtocolsCache = res.data;
        }

        // Fuzzy search in the list
        // 1. Exact slug match
        const exact = allProtocolsCache.find(p => p.slug === searchName || p.name.toLowerCase() === searchName);
        if (exact) return exact.slug;

        // 2. Contains match (e.g. 'hop' -> 'hop-protocol')
        // OR searchName contains slug (e.g. 'stargatev2' -> 'stargate')
        const bestMatch = allProtocolsCache.find(p =>
            p.slug.includes(searchName) ||
            p.name.toLowerCase().includes(searchName) ||
            searchName.includes(p.slug)
        );

        if (bestMatch) return bestMatch.slug;

        // 3. Try stripping version suffixes (e.g. 'stargatev2' -> 'stargate')
        const strippedName = searchName.replace(/v\d+$/i, '');
        if (strippedName !== searchName) {
            const strippedMatch = allProtocolsCache.find(p =>
                p.slug === strippedName ||
                p.slug.includes(strippedName)
            );
            if (strippedMatch) return strippedMatch.slug;
        }

        return bridgeName; // Fallback to input if not found
    } catch (e) {
        // Fallback if API fails
        return overrides[searchName] || searchName;
    }
}

// --- EXPORTED TOOLS ---

// 1. Get Technical Route
async function getRoute(fromChainRaw, toChainRaw, fromTokenRaw, amountRaw, toTokenRaw) {
    const fromChain = normalizeChain(fromChainRaw);
    const toChain = normalizeChain(toChainRaw);
    const toToken = toTokenRaw || fromTokenRaw;

    // Resolve Amounts
    let amount = amountRaw;
    // Note: In single getRoute, we assume user might have passed atomic or not. 
    // Ideally we'd use getTokenDetails to check decimals here too if strictly needed, 
    // but for now keeping it simple as this tool is legacy/fallback vs getBridgeOptions.

    try {
        const res = await axios.get('https://li.quest/v1/quote', {
            timeout: 10000,
            params: {
                fromChain,
                toChain,
                fromToken: fromTokenRaw,
                toToken: toToken,
                fromAmount: amount,
                fromAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
            }
        });

        const data = res.data;

        // Extract Fees
        const fees = (data.estimate.feeCosts || []).map(f => ({
            name: f.name,
            amount: f.amount,
            symbol: f.token.symbol,
            amountUSD: f.amountUSD
        }));

        const gas = (data.estimate.gasCosts || []).map(g => ({
            type: g.type, // e.g. 'SEND'
            amountUSD: g.amountUSD,
            symbol: g.token.symbol,
            limit: g.limit
        }));

        const totalGasUSD = gas.reduce((sum, g) => sum + parseFloat(g.amountUSD || 0), 0);

        // Split Fees: Aggregator (Li.Fi) vs Protocol (Bridge/Relayer)
        const aggregatorFees = fees.filter(f => f.name.includes('LIFI'));
        const protocolFees = fees.filter(f => !f.name.includes('LIFI'));

        const aggregatorFeeUSD = aggregatorFees.reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);
        const protocolFeeUSD = protocolFees.reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);

        return {
            success: true,
            bridgeName: data.toolDetails.key,
            estimatedTime: formatDuration(data.estimate.executionDuration), // Formatted
            gasCostUSD: totalGasUSD.toFixed(4),
            protocolFeeUSD: protocolFeeUSD.toFixed(4),
            aggregatorFeeUSD: aggregatorFeeUSD.toFixed(4), // Li.Fi Fee
            feeDetails: fees,
            gasDetails: gas,
            tokenAddress: data.action.fromToken.address,
            amountOut: data.estimate.toAmount,
            amountIn: amount
        };

    } catch (e) {
        return {
            success: false,
            error: e.response?.data?.message || e.message
        };
    }
}

// 1.5 Get Multi-Bridge Comparison
// 1.5 Get Multi-Bridge Comparison
async function getBridgeOptions(fromChainRaw, toChainRaw, fromTokenRaw, amountRaw, toTokenRaw) {
    const fromChain = normalizeChain(fromChainRaw);
    const toChain = normalizeChain(toChainRaw);
    let amount = amountRaw;

    try {
        // --- 1. Robust Token Resolution ---
        // Use the shared helper to get address + decimals
        // This handles "USDT" on Arb vs Opt correctly via the fallback list
        let fromTokenAddr = fromTokenRaw;

        if (!fromTokenAddr.startsWith('0x')) {
            const tokenDetails = await getTokenDetails(fromChain, fromTokenRaw);
            if (tokenDetails.success) {
                fromTokenAddr = tokenDetails.address;
            }
        }

        let toTokenAddr = toTokenRaw || fromTokenRaw;
        // For 'toToken', if it's a symbol, we accept it might resolve on the other side.
        // But Li.Fi advanced routes usually prefer addresses.
        if (!toTokenAddr.startsWith('0x')) {
            const tokenDetails = await getTokenDetails(toChain, toTokenAddr);
            if (tokenDetails.success) {
                toTokenAddr = tokenDetails.address;
            }
        }

        // --- 2. Fetch Routes ---
        const params = {
            fromChainId: CHAIN_MAP[fromChain] || fromChain,
            toChainId: CHAIN_MAP[toChain] || toChain,
            fromTokenAddress: fromTokenAddr,
            toTokenAddress: toTokenAddr,
            fromAmount: amount,
            options: { order: 'RECOMMENDED', limit: 3 }
        };

        const res = await axios.post('https://li.quest/v1/advanced/routes', params, { timeout: 15000 });

        const routes = await Promise.all(res.data.routes.map(async (r) => {
            const bridgeKey = r.steps[0].toolDetails.key;

            // Get Risk (Parallel) with improved lookup
            const security = await getSecurityStats(bridgeKey);
            const risk = calculateRiskScore(security);

            // Calculate Fees
            const fees = (r.steps[0].estimate.feeCosts || []);
            const aggUSD = fees.filter(f => f.name.includes('LIFI')).reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);
            const protUSD = fees.filter(f => !f.name.includes('LIFI')).reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);

            return {
                bridge: bridgeKey,
                amountOut: r.toAmount,
                gasCostUSD: r.gasCostUSD,
                protocolFeeUSD: protUSD.toFixed(4),
                aggregatorFeeUSD: aggUSD.toFixed(4),
                executionDuration: formatDuration(r.steps[0].estimate.executionDuration),
                riskScore: risk.score,
                securityVerdict: risk.verdict,
                securityReason: risk.explanation
            };
        }));

        return { success: true, options: routes };

    } catch (e) {
        return { success: false, error: e.response?.data?.message || e.message };
    }
}

// 4. List Supported Bridges
async function getSupportedBridges() {
    try {
        const res = await axios.get('https://li.quest/v1/tools', { timeout: 10000 });
        const bridges = res.data.bridges.map(b => b.name);
        return {
            success: true,
            total: bridges.length,
            bridges: bridges
        };
    } catch (e) {
        return { success: false, error: e.response?.data?.message || e.message };
    }
}

// 2. Get Security Context
async function getSecurityStats(bridgeName) {
    const slug = await getProtocolSlug(bridgeName);


    try {
        const [tvlRes, hacksRes] = await Promise.allSettled([
            axios.get(`https://api.llama.fi/protocol/${slug}`, { timeout: 10000 }),
            axios.get('https://api.llama.fi/hacks', { timeout: 10000 })
        ]);

        let tvl = "Unknown";
        let hacks = [];

        if (tvlRes.status === 'fulfilled' && tvlRes.value.data.tvl) {
            // Handle different DefiLlama response structures
            const rawTvl = Array.isArray(tvlRes.value.data.tvl)
                ? tvlRes.value.data.tvl.reduce((a, b) => a + b.totalLiquidityUSD, 0)
                : tvlRes.value.data.currentChainTvls
                    ? Object.values(tvlRes.value.data.currentChainTvls).reduce((a, b) => a + b, 0)
                    : 0;
            tvl = `$${(rawTvl / 1_000_000).toFixed(2)}M`;
        }

        if (hacksRes.status === 'fulfilled') {
            hacks = hacksRes.value.data.filter(h => h.name.toLowerCase().includes(slug));
        }

        // Filter only recent hacks (last 2 years) for relevance
        const recentHacks = hacks.filter(h => h.date > (Date.now() / 1000 - 63072000));

        return {
            bridge: bridgeName,
            tvl,
            recent_hack_count: recentHacks.length,
            hack_details: recentHacks.map(h => `${h.date}: ${h.classification} ($${h.amount} lost)`),
            audit_status: "Check L2Beat for details" // L2Beat API requires more complex scraping
        };

    } catch (error) {
        return { bridge: bridgeName, error: "Security data unavailable" };
    }
}

// 3. Get Token Details (Dynamic Discovery with Fallback)
async function getTokenDetails(chainRaw, tokenSymbol) {
    const chain = normalizeChain(chainRaw);
    try {
        const res = await axios.get('https://li.quest/v1/token', {
            timeout: 10000,
            params: { chain, token: tokenSymbol }
        });
        return {
            success: true,
            symbol: res.data.symbol,
            address: res.data.address,
            decimals: res.data.decimals,
            chainId: res.data.chainId,
            priceUSD: res.data.priceUSD
        };
    } catch (e) {
        // Fallback for tricky tokens where API fails by symbol
        // (Li.Fi sometimes expects 'USDT.e' or 'bridged-usdt' but user says 'USDT')
        const FALLBACK_TOKENS = {
            // Arbitrum (42161)
            42161: {
                'USDT': { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
                'USDC': { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }
            },
            // Optimism (10)
            10: {
                'USDT': { address: '0x94b008aA00579c1307B0EF2c499a98a359659952', decimals: 6 }
            }
        };

        const fallback = FALLBACK_TOKENS[chain]?.[tokenSymbol.toUpperCase()];
        if (fallback) {
            return {
                success: true,
                symbol: tokenSymbol.toUpperCase(),
                address: fallback.address,
                decimals: fallback.decimals,
                chainId: chain,
                priceUSD: "Unknown (Fallback)"
            };
        }

        return { success: false, error: e.response?.data?.message || e.message };
    }
}

// 4. Deterministic Risk Scoring
function calculateRiskScore(securityStats) {
    let score = 100;
    const rules = [];

    // Rule 1: Hacks (Critical)
    if (securityStats.recent_hack_count > 0) {
        score = 0;
        rules.push("CRITICAL: Protocol was hacked recently.");
        return {
            score: 0,
            verdict: "DANGER",
            explanation: `DANGER: Protocol has ${securityStats.recent_hack_count} recent hacks. Immediate risk.`
        };
    }

    // Rule 2: TVL Assessment
    if (securityStats.tvl === "Unknown") {
        score -= 30;
        rules.push("Penalty: TVL data unavailable (-30)");
    } else {
        // Parse "$12.50M" -> 12.50
        const tvlNum = parseFloat(securityStats.tvl.replace(/[^0-9.]/g, ''));
        if (tvlNum < 10) { // < $10M
            score -= 20;
            rules.push(`Caution: Low TVL (${securityStats.tvl} < $10M) (-20)`);
        }
    }

    // Determine Verdict
    let verdict = "SECURE";
    if (score < 40) verdict = "DANGER";
    else if (score < 80) verdict = "CAUTION";

    return {
        score,
        verdict,
        explanation: rules.length > 0 ? rules.join("; ") : "Standard security checks passed."
    };
}

module.exports = { getRoute, getBridgeOptions, getSecurityStats, calculateRiskScore, getTokenDetails, getSupportedBridges };