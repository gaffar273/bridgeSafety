const { runAgent } = require('./agent');

const userQuery = process.argv.slice(2).join(" ");

if (!userQuery) {
    console.log("\n Usage Example:");
    console.log('   npm start "send 5000 usdc from base to arbitrum"');
    console.log('   npm start "bridge 10 eth from mainnet to optimism"\n');
    process.exit(1);
}

(async () => {
    try {
        const report = await runAgent(userQuery);

        if (report) {
            console.log("\n=========================================");
            console.log(" 🌉 BRIDGE SECURITY ADVISOR");
            console.log("=========================================");
            console.log(` VERDICT:  ${report.verdict}`);
            console.log(` SCORE:    ${report.score}/100`);
            console.log(` DETAILS:  ${report.explanation}`);
            console.log("=========================================\n");
        }
    } catch (error) {
        console.error("Critical Error:", error);
    }
})();