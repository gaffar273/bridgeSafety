const { getBridgeOptions } = require('./src/tools');

async function run() {
    console.log("Fetching bridge options for 100 USDT from Arbitrum to Optimism (using symbols)...");
    try {
        // Now passing symbols directly to test the new robust token resolution logic
        // logic should fallback to getTokenDetails automatically
        const result = await getBridgeOptions('arb', 'opt', 'USDT', '100', 'USDT');

        if (result.success) {
            console.log("\n--- Comparison Results ---");
            result.options.forEach(opt => {
                console.log(`\nBridge: ${opt.bridge}`);
                console.log(`Duration: ${opt.executionDuration}`); // Should be formatted
                console.log(`Protocol Fee: $${opt.protocolFeeUSD}`);
                console.log(`Aggregator Fee: $${opt.aggregatorFeeUSD}`);
                console.log(`Risk: ${opt.riskScore} (${opt.securityVerdict})`);
                console.log(`Reason: ${opt.securityReason}`);
            });
        } else {
            console.error("Error:", result.error);
        }

    } catch (error) {
        console.error("Crash:", error);
    }
}

run();
