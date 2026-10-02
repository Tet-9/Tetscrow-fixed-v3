/**
 * Tetscrow deployment script — Arc Testnet or Arc Mainnet
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network arcTestnet
 *   npx hardhat run scripts/deploy.js --network arcMainnet
 *
 * Required env vars (set in contracts/.env):
 *   DEPLOYER_PRIVATE_KEY   — hex private key of the deployer wallet
 *   ARBITRATOR_ADDRESS     — address that will resolve disputes (can be the deployer initially)
 *   OWNER_ADDRESS          — platform multisig or deployer; owns transferArbitrator()
 *
 * USDC on Arc (same address on both testnet and mainnet):
 *   0x3600000000000000000000000000000000000000
 */
const hre = require("hardhat");

const ARC_USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  if (!deployer) throw new Error("No deployer account — set DEPLOYER_PRIVATE_KEY in contracts/.env");
  console.log(`Deploying Tetscrow on ${network} with: ${deployer.address}`);

  const arbitrator = process.env.ARBITRATOR_ADDRESS || deployer.address;
  const owner      = process.env.OWNER_ADDRESS      || deployer.address;

  console.log(`  USDC:        ${ARC_USDC}`);
  console.log(`  Arbitrator:  ${arbitrator}`);
  console.log(`  Owner:       ${owner}`);

  const Tetscrow = await hre.ethers.getContractFactory("Tetscrow");
  const tetscrow = await Tetscrow.deploy(ARC_USDC, arbitrator, owner);
  await tetscrow.waitForDeployment();

  const address = await tetscrow.getAddress();
  console.log(`\nTetscrow deployed: ${address}`);

  const explorer =
    network === "arcMainnet"
      ? `https://explorer.arc.io/address/${address}`
      : `https://testnet.arcscan.app/address/${address}`;
  console.log(`Explorer:          ${explorer}`);

  console.log("\nNext steps:");
  console.log("  1. Copy the contract address into frontend/js/config.js → TETSCROW_ESCROW_ADDRESS");
  console.log("  2. Copy it into backend/.env → TETSCROW_ESCROW_ADDRESS");
  console.log("  3. Users approve Tetscrow to spend their USDC automatically when they create an escrow.");
  console.log("  4. Remember: every wallet that transacts on Arc needs a little USDC for gas.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
