require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris", // Arc target per contract docs — no Cancun-only opcodes
    },
  },
  networks: {
    // Arc Testnet — USDC is the gas token; get some from https://faucet.circle.com
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts,
    },
    // Arc Mainnet — real USDC. Deploy only after a full audit.
    arcMainnet: {
      url: process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts,
    },
  },
};
