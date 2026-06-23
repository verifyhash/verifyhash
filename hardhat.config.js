require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const AMOY_RPC_URL = process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Emit compiled NatSpec (devdoc/userdoc) into the build-info so tests can assert that the
      // documented trust boundaries (uri = untrusted hint; timestamp/blockNumber = ordering + an
      // upper bound on existence time, NOT authorship time) are present in the *compiled* contract
      // documentation, not merely in source comments. See test/TrustBoundaries.test.js (T-0.4).
      outputSelection: {
        "*": {
          "*": ["devdoc", "userdoc"],
        },
      },
    },
  },
  networks: {
    hardhat: {},
    // Polygon Amoy testnet. Fund a throwaway key from a faucet; never a real-funds key.
    amoy: {
      url: AMOY_RPC_URL,
      chainId: 80002,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
