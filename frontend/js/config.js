/**
 * Tetscrow — frontend configuration
 *
 * Fill in TETSCROW_ESCROW_ADDRESS after running the deploy script.
 * USDC address is the same on both Arc networks (Arc predeploy).
 *
 * To switch between testnet and mainnet, change NETWORK to "mainnet".
 */
window.TETSCROW_CONFIG = (function () {
  // "testnet" | "mainnet"
  var NETWORK = "testnet";

  var ARC_USDC = "0x3600000000000000000000000000000000000000";

  var NETWORKS = {
    testnet: {
      name:          "Arc Testnet",
      chainId:       5042002,
      chainIdHex:    "0x4cef52",
      // Primary first; the rest are tried by the read-only provider and offered to the wallet.
      rpcs:          ["https://rpc.testnet.arc.io", "https://rpc.testnet.arc.network"],
      explorer:      "https://testnet.arcscan.app",
      faucet:        "https://faucet.circle.com",
      escrowAddress: "0xDDFa5c46094BE94bbEa99E45e12d31448e026bbe",
    },
    mainnet: {
      name:          "Arc",
      chainId:       5042,
      chainIdHex:    "0x13b2",
      rpcs:          ["https://rpc.mainnet.arc.io"],
      explorer:      "https://explorer.arc.io",
      faucet:        null,
      escrowAddress: "", // <-- paste your deployed address here after running deploy.js --network arcMainnet
    },
  };

  var net = NETWORKS[NETWORK];

  return {
    NETWORK:            NETWORK,
    NETWORKS:           NETWORKS,
    // Override without editing this file:  <script>window.TETSCROW_API_BASE="https://api.example.com"</script>
    API_BASE:           window.TETSCROW_API_BASE || "http://localhost:8000",
    CHAIN_ID:           net.chainId,
    CHAIN_ID_HEX:       net.chainIdHex,
    CHAIN_NAME:         net.name,
    RPC_URL:            net.rpcs[0],
    RPC_URLS:           net.rpcs,
    EXPLORER:           net.explorer,
    FAUCET:             net.faucet,
    TETSCROW_ESCROW_ADDRESS: net.escrowAddress,
    USDC_ADDRESS:       ARC_USDC,
    USDC_DECIMALS:      6,

    // Helper: build an explorer URL for a tx hash or address
    explorerTx:   function (hash)    { return net.explorer + "/tx/"      + hash; },
    explorerAddr: function (address) { return net.explorer + "/address/" + address; },
  };
})();

// ------------------------------------------------------------------
// Tetscrow ABI (Solidity 0.8.28, Arc)
// ------------------------------------------------------------------
window.TETSCROW_ESCROW_ABI = [
  // Write
  "function createEscrow(address payee, tuple(bytes32 descriptionHash, uint256 amount)[] inputs, uint40 deadline) external returns (uint256 escrowId)",
  "function markDelivered(uint256 escrowId, uint256 milestoneId) external",
  "function releaseMilestone(uint256 escrowId, uint256 milestoneId) external",
  "function initiateMutualCancel(uint256 escrowId) external",
  "function claimTimeout(uint256 escrowId) external",
  "function raiseDispute(uint256 escrowId, uint256 milestoneId) external",
  "function resolveDispute(uint256 escrowId, uint256 milestoneId, uint256 payerShare, uint256 payeeShare) external",
  "function claimAfterReview(uint256 escrowId, uint256 milestoneId) external",
  "function withdraw() external",
  "function transferArbitrator(address newArbitrator) external",
  "function acceptArbitrator() external",
  // Read
  "function getEscrow(uint256 escrowId) view returns (address payer, address payee, uint40 deadline, uint8 status, bool payerCancelIntent, bool payeeCancelIntent, uint256 milestoneCount)",
  "function getMilestone(uint256 escrowId, uint256 milestoneId) view returns (bytes32 descriptionHash, uint256 amount, uint8 status, uint40 deliveredAt)",
  "function REVIEW_PERIOD() view returns (uint256)",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function escrowCount() view returns (uint256)",
  "function arbitrator() view returns (address)",
  "function MAX_MILESTONES() view returns (uint256)",
  // Events
  "event EscrowCreated(uint256 indexed escrowId, address indexed payer, address indexed payee, uint256 totalAmount, uint40 deadline, uint256 milestoneCount)",
  "event MilestoneDelivered(uint256 indexed escrowId, uint256 indexed milestoneId)",
  "event MilestoneReleased(uint256 indexed escrowId, uint256 indexed milestoneId, uint256 amount)",
  "event MutualCancelInitiated(uint256 indexed escrowId, address indexed initiator)",
  "event EscrowCancelled(uint256 indexed escrowId, uint256 refundAmount)",
  "event DisputeRaised(uint256 indexed escrowId, uint256 indexed milestoneId, address indexed raisedBy)",
  "event DisputeResolved(uint256 indexed escrowId, uint256 indexed milestoneId, uint256 payerShare, uint256 payeeShare)",
  "event EscrowCompleted(uint256 indexed escrowId)",
  "error ZeroAddress()", "error SelfEscrow()", "error InvalidMilestone()", "error ReviewPeriodNotOver()",
  "error DeadlineInPast()", "error EmptyMilestones()", "error TooManyMilestones()", "error ZeroMilestoneAmount()",
  "error ZeroTotalAmount()", "error NotPayer()", "error NotPayee()", "error NotParty()", "error NotArbitrator()",
  "error EscrowNotActive()", "error MilestoneNotReleasable()", "error MilestoneNotDeliverable()",
  "error MilestoneNotDisputable()", "error MilestoneNotDisputed()", "error SharesMismatch()",
  "error AlreadyInitiatedCancel()", "error DeadlineNotReached()", "error NotPendingArbitrator()",
  "error NothingToWithdraw()", "error ArbitratorChangeNotReady()", "error RenounceOwnershipDisabled()",
  "event Paid(address indexed recipient, uint256 amount)",
  "event WithdrawalCredited(address indexed recipient, uint256 amount)",
  "event Withdrawn(address indexed recipient, uint256 amount)",
];

// Pre-upgrade contract (no deliveredAt / claimAfterReview). Used only as a read fallback.
window.TETSCROW_ESCROW_ABI_LEGACY = [
  "function getMilestone(uint256 escrowId, uint256 milestoneId) view returns (bytes32 descriptionHash, uint256 amount, uint8 status)",
];

// USDC ERC-20 ABI (minimal — all Tetscrow needs is approve + allowance + balanceOf)
window.USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Milestone status labels (matches MilestoneStatus enum order in Solidity)
window.MILESTONE_STATUS = ["Funded", "Delivered", "Released", "Disputed", "Refunded", "Resolved"];

// Escrow status labels (matches EscrowStatus enum order)
window.ESCROW_STATUS = ["Active", "Completed", "Cancelled"];

window.REVIEW_PERIOD_FALLBACK_SECONDS = 7 * 24 * 60 * 60;
