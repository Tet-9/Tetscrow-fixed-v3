// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Tetscrow
 * @notice Milestone-based USDC escrow platform on Arc.
 *         Payer locks USDC at creation; each milestone is released individually on payer approval.
 *         Supports mutual cancellation, deadline-based timeout refund, and platform arbitration.
 *
 * @dev PUSH-WITH-PULL-FALLBACK: every settlement first tries to send USDC straight to the
 *      recipient, so a receiver is paid the moment the payer releases (no extra transaction,
 *      and no gas needed on their side). If that direct transfer fails (e.g. the recipient is
 *      USDC-blocklisted), the amount is credited to pendingWithdrawals[address] and the
 *      recipient can claim it later with withdraw(). A failing recipient therefore can never
 *      lock an escrow. All settlement paths are nonReentrant and update state before paying.
 *
 *      PAYEE PROTECTION: if the payer goes silent after a delivery, the payee can call
 *      claimAfterReview() once REVIEW_PERIOD has passed since markDelivered().
 *
 *      DISPUTE SAFETY: Milestones in Disputed state are excluded from timeout/cancel refunds.
 *      Only resolveDispute() (arbitrator) may settle a Disputed milestone.
 *
 *      TIMEOUT FAIRNESS: claimTimeout() only refunds Funded (undelivered) milestones.
 *      A payee who already called markDelivered() keeps their claim — the payer must
 *      explicitly release or dispute a Delivered milestone; waiting out the clock is not enough.
 *
 * @custom:target  Arc Testnet (chain 5042002) / Arc Mainnet (chain 5042)
 * @custom:usdc    0x3600000000000000000000000000000000000000 (same address on both networks)
 * @custom:evm     Paris (no Cancun opcodes required)
 * @custom:oz      OpenZeppelin 5.1.0
 */
contract Tetscrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant MAX_MILESTONES = 20;

    /// @notice Time the payer has to release or dispute a Delivered milestone before the
    ///         payee may claim it with claimAfterReview().
    uint256 public constant REVIEW_PERIOD = 7 days;

    /// @notice Minimum delay before a queued arbitrator change can be accepted.
    uint256 public constant ARBITRATOR_CHANGE_DELAY = 2 days;

    // -------------------------------------------------------------------------
    // Enums
    // -------------------------------------------------------------------------

    enum EscrowStatus {
        Active,
        Completed,
        Cancelled
    }

    enum MilestoneStatus {
        Funded,
        Delivered,
        Released,
        Disputed,
        Refunded,
        Resolved   // settled by the arbitrator (split between payer and payee)
    }

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct MilestoneInput {
        bytes32 descriptionHash; // keccak256 of off-chain milestone description
        uint256 amount;          // USDC amount (6 decimals on Arc)
    }

    struct Milestone {
        bytes32 descriptionHash;
        uint256 amount;
        MilestoneStatus status;
        uint40 deliveredAt;      // set by markDelivered(); starts the review period
    }

    struct Escrow {
        address payer;
        address payee;
        uint40  deadline;          // unix timestamp — payer may reclaim Funded milestones after this
        EscrowStatus status;
        bool payerCancelIntent;
        bool payeeCancelIntent;
        Milestone[] milestones;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Arc USDC ERC-20 (0x3600000000000000000000000000000000000000 on both networks).
    IERC20 public immutable usdc;

    address public arbitrator;
    address public pendingArbitrator;
    uint256 public arbitratorChangeEta;

    /// @notice Monotonically increasing escrow counter. First escrowId = 1.
    uint256 public escrowCount;

    mapping(uint256 => Escrow) private _escrows;

    /// @notice Pull-payment ledger. Credited by settlement functions; drained by withdraw().
    mapping(address => uint256) public pendingWithdrawals;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed payer,
        address indexed payee,
        uint256 totalAmount,
        uint40  deadline,
        uint256 milestoneCount
    );
    event MilestoneDelivered(uint256 indexed escrowId, uint256 indexed milestoneId);
    event MilestoneReleased(uint256 indexed escrowId, uint256 indexed milestoneId, uint256 amount);
    event MutualCancelInitiated(uint256 indexed escrowId, address indexed initiator);
    event EscrowCancelled(uint256 indexed escrowId, uint256 refundAmount);
    event DisputeRaised(uint256 indexed escrowId, uint256 indexed milestoneId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed escrowId, uint256 indexed milestoneId, uint256 payerShare, uint256 payeeShare);
    event EscrowCompleted(uint256 indexed escrowId);
    event Paid(address indexed recipient, uint256 amount);
    event WithdrawalCredited(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);
    event ArbitratorTransferInitiated(address indexed newArbitrator);
    event ArbitratorTransferred(address indexed oldArbitrator, address indexed newArbitrator);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error SelfEscrow();
    error InvalidMilestone();
    error ReviewPeriodNotOver();
    error DeadlineInPast();
    error EmptyMilestones();
    error TooManyMilestones();
    error ZeroMilestoneAmount();
    error ZeroTotalAmount();
    error NotPayer();
    error NotPayee();
    error NotParty();
    error NotArbitrator();
    error EscrowNotActive();
    error MilestoneNotReleasable();
    error MilestoneNotDeliverable();
    error MilestoneNotDisputable();
    error MilestoneNotDisputed();
    error SharesMismatch();
    error AlreadyInitiatedCancel();
    error DeadlineNotReached();
    error NotPendingArbitrator();
    error NothingToWithdraw();
    error ArbitratorChangeNotReady();
    error RenounceOwnershipDisabled();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyPayer(uint256 escrowId) {
        if (msg.sender != _escrows[escrowId].payer) revert NotPayer();
        _;
    }

    modifier onlyPayee(uint256 escrowId) {
        if (msg.sender != _escrows[escrowId].payee) revert NotPayee();
        _;
    }

    modifier onlyParty(uint256 escrowId) {
        Escrow storage e = _escrows[escrowId];
        if (msg.sender != e.payer && msg.sender != e.payee) revert NotParty();
        _;
    }

    modifier onlyArbitrator() {
        if (msg.sender != arbitrator) revert NotArbitrator();
        _;
    }

    modifier validMilestone(uint256 escrowId, uint256 milestoneId) {
        if (milestoneId >= _escrows[escrowId].milestones.length) revert InvalidMilestone();
        _;
    }

    modifier escrowActive(uint256 escrowId) {
        if (_escrows[escrowId].status != EscrowStatus.Active) revert EscrowNotActive();
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param usdc_        Arc USDC address (0x3600000000000000000000000000000000000000)
     * @param arbitrator_  Initial platform arbitrator
     * @param owner_       Contract owner (platform multisig or deployer)
     */
    constructor(IERC20 usdc_, address arbitrator_, address owner_) Ownable(owner_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (arbitrator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        arbitrator = arbitrator_;
        // escrowCount = 0; first ID issued = 1
    }

    // -------------------------------------------------------------------------
    // Core escrow functions
    // -------------------------------------------------------------------------

    /**
     * @notice Create an escrow and lock USDC from the payer.
     * @param payee_     Payee address (service provider / seller).
     * @param inputs     Array of milestone inputs (descriptionHash + USDC amount each).
     * @param deadline_  Unix timestamp. After this, payer may claimTimeout for Funded milestones.
     * @return escrowId  Newly created escrow ID (1-indexed).
     */
    function createEscrow(
        address payee_,
        MilestoneInput[] calldata inputs,
        uint40 deadline_
    ) external nonReentrant returns (uint256 escrowId) {
        if (payee_ == address(0)) revert ZeroAddress();
        if (payee_ == msg.sender) revert SelfEscrow();
        if (deadline_ <= block.timestamp) revert DeadlineInPast();
        if (inputs.length == 0) revert EmptyMilestones();
        if (inputs.length > MAX_MILESTONES) revert TooManyMilestones();

        uint256 total = 0;
        for (uint256 i = 0; i < inputs.length; i++) {
            if (inputs[i].amount == 0) revert ZeroMilestoneAmount();
            total += inputs[i].amount;
        }
        if (total == 0) revert ZeroTotalAmount();

        // Assign ID (1-based)
        escrowCount++;
        escrowId = escrowCount;

        // CEI: write all state before transferring
        Escrow storage e = _escrows[escrowId];
        e.payer    = msg.sender;
        e.payee    = payee_;
        e.deadline = deadline_;
        e.status   = EscrowStatus.Active;

        for (uint256 i = 0; i < inputs.length; i++) {
            e.milestones.push(Milestone({
                descriptionHash: inputs[i].descriptionHash,
                amount: inputs[i].amount,
                status: MilestoneStatus.Funded,
                deliveredAt: 0
            }));
        }

        // Interaction: pull USDC from payer (state fully written above)
        usdc.safeTransferFrom(msg.sender, address(this), total);

        emit EscrowCreated(escrowId, msg.sender, payee_, total, deadline_, inputs.length);
    }

    /**
     * @notice Payee signals that a milestone deliverable is ready for review.
     * @dev Does not move funds. Payer may release without this signal if satisfied early.
     */
    function markDelivered(
        uint256 escrowId,
        uint256 milestoneId
    ) external onlyPayee(escrowId) escrowActive(escrowId) validMilestone(escrowId, milestoneId) {
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        if (m.status != MilestoneStatus.Funded) revert MilestoneNotDeliverable();
        m.status = MilestoneStatus.Delivered;
        m.deliveredAt = uint40(block.timestamp);
        emit MilestoneDelivered(escrowId, milestoneId);
    }

    /**
     * @notice Payer releases a milestone payment to the payee.
     * @dev Works on both Funded and Delivered milestones — payer does not need to wait
     *      for markDelivered() if they are already satisfied.
     *      USDC is sent straight to the payee (credited to pendingWithdrawals only if the
     *      direct transfer fails).
     */
    function releaseMilestone(
        uint256 escrowId,
        uint256 milestoneId
    ) external nonReentrant onlyPayer(escrowId) escrowActive(escrowId) validMilestone(escrowId, milestoneId) {
        _release(escrowId, milestoneId);
    }

    /**
     * @notice Payee claims a Delivered milestone when the payer has neither released nor
     *         disputed it within REVIEW_PERIOD of the delivery signal.
     */
    function claimAfterReview(
        uint256 escrowId,
        uint256 milestoneId
    ) external nonReentrant onlyPayee(escrowId) escrowActive(escrowId) validMilestone(escrowId, milestoneId) {
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        if (m.status != MilestoneStatus.Delivered) revert MilestoneNotReleasable();
        if (block.timestamp < uint256(m.deliveredAt) + REVIEW_PERIOD) revert ReviewPeriodNotOver();
        _release(escrowId, milestoneId);
    }

    /**
     * @notice Either party initiates a mutual cancellation.
     *         When both parties have called this, all Funded and Delivered milestones
     *         are refunded to the payer (payee consented by agreeing to cancel).
     *         Disputed milestones are excluded and must be resolved by the arbitrator.
     */
    function initiateMutualCancel(
        uint256 escrowId
    ) external nonReentrant onlyParty(escrowId) escrowActive(escrowId) {
        Escrow storage e = _escrows[escrowId];
        bool isPayer = (msg.sender == e.payer);

        if (isPayer) {
            if (e.payerCancelIntent) revert AlreadyInitiatedCancel();
            e.payerCancelIntent = true;
        } else {
            if (e.payeeCancelIntent) revert AlreadyInitiatedCancel();
            e.payeeCancelIntent = true;
        }

        emit MutualCancelInitiated(escrowId, msg.sender);

        if (e.payerCancelIntent && e.payeeCancelIntent) {
            _cancelAndRefundNonDisputed(escrowId);
        }
    }

    /**
     * @notice Payer (or anyone) calls this after the deadline to reclaim Funded (undelivered)
     *         milestones. Delivered milestones are NOT touched — a payee who signalled delivery
     *         retains their claim and the payer must release or dispute those explicitly.
     *         Disputed milestones must go through resolveDispute().
     */
    function claimTimeout(
        uint256 escrowId
    ) external nonReentrant escrowActive(escrowId) {
        if (block.timestamp <= _escrows[escrowId].deadline) revert DeadlineNotReached();
        _timeoutRefundFundedOnly(escrowId);
    }

    /**
     * @notice Either party escalates a milestone to disputed status; funds freeze.
     *         Only works on Funded or Delivered milestones — not yet Released or already Disputed.
     */
    function raiseDispute(
        uint256 escrowId,
        uint256 milestoneId
    ) external onlyParty(escrowId) escrowActive(escrowId) validMilestone(escrowId, milestoneId) {
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        if (m.status != MilestoneStatus.Funded && m.status != MilestoneStatus.Delivered)
            revert MilestoneNotDisputable();

        m.status = MilestoneStatus.Disputed;
        emit DisputeRaised(escrowId, milestoneId, msg.sender);
    }

    /**
     * @notice Platform arbitrator resolves a disputed milestone by splitting the amount.
     * @param payerShare  USDC amount returned to payer (0 = full release to payee).
     * @param payeeShare  USDC amount paid to payee (0 = full refund to payer).
     * @dev payerShare + payeeShare must equal the milestone amount exactly (no dust left).
     */
    function resolveDispute(
        uint256 escrowId,
        uint256 milestoneId,
        uint256 payerShare,
        uint256 payeeShare
    ) external nonReentrant onlyArbitrator escrowActive(escrowId) validMilestone(escrowId, milestoneId) {
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        if (m.status != MilestoneStatus.Disputed) revert MilestoneNotDisputed();
        if (payerShare + payeeShare != m.amount) revert SharesMismatch();

        Escrow storage e = _escrows[escrowId];
        address payer_ = e.payer;
        address payee_ = e.payee;

        // CEI: update state before paying
        m.status = MilestoneStatus.Resolved;

        if (payerShare > 0) _pay(payer_, payerShare);
        if (payeeShare > 0) _pay(payee_, payeeShare);

        emit DisputeResolved(escrowId, milestoneId, payerShare, payeeShare);
        _checkAllMilestonesResolved(escrowId);
    }

    // -------------------------------------------------------------------------
    // Withdrawal (pull-payment)
    // -------------------------------------------------------------------------

    /**
     * @notice Withdraw USDC that could not be delivered directly (fallback path).
     * @dev Zeroes balance before transfer.
     */
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // CEI: zero balance before transferring
        pendingWithdrawals[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Arbitrator management (two-step, timelocked)
    // -------------------------------------------------------------------------

    /**
     * @notice Owner queues an arbitrator rotation. New arbitrator cannot accept until
     *         ARBITRATOR_CHANGE_DELAY (2 days) has elapsed. Prevents instant hostile takeover
     *         if the owner key is compromised.
     */
    function transferArbitrator(address newArbitrator) external onlyOwner {
        if (newArbitrator == address(0)) revert ZeroAddress();
        pendingArbitrator    = newArbitrator;
        arbitratorChangeEta  = block.timestamp + ARBITRATOR_CHANGE_DELAY;
        emit ArbitratorTransferInitiated(newArbitrator);
    }

    /**
     * @notice Pending arbitrator finalises the rotation after the timelock expires.
     */
    function acceptArbitrator() external {
        if (msg.sender != pendingArbitrator) revert NotPendingArbitrator();
        if (block.timestamp < arbitratorChangeEta) revert ArbitratorChangeNotReady();
        address old      = arbitrator;
        arbitrator       = pendingArbitrator;
        pendingArbitrator = address(0);
        arbitratorChangeEta = 0;
        emit ArbitratorTransferred(old, arbitrator);
    }

    /**
     * @notice Permanently disabled — renouncing ownership would leave the arbitrator
     *         unrotatable, removing a critical safety path.
     */
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /// @notice Returns core escrow fields without the milestones array.
    function getEscrow(uint256 escrowId) external view returns (
        address payer,
        address payee,
        uint40  deadline,
        EscrowStatus status,
        bool payerCancelIntent,
        bool payeeCancelIntent,
        uint256 milestoneCount
    ) {
        Escrow storage e = _escrows[escrowId];
        return (e.payer, e.payee, e.deadline, e.status,
                e.payerCancelIntent, e.payeeCancelIntent, e.milestones.length);
    }

    /// @notice Returns a single milestone's data.
    function getMilestone(uint256 escrowId, uint256 milestoneId) external view returns (
        bytes32 descriptionHash,
        uint256 amount,
        MilestoneStatus status,
        uint40 deliveredAt
    ) {
        if (milestoneId >= _escrows[escrowId].milestones.length) revert InvalidMilestone();
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        return (m.descriptionHash, m.amount, m.status, m.deliveredAt);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Pay `amount` USDC to `recipient`. Tries a direct transfer first; if it fails
     *      (blocklisted recipient, etc.) the amount is credited for later withdraw().
     */
    function _pay(address recipient, uint256 amount) internal {
        try usdc.transfer(recipient, amount) returns (bool ok) {
            if (ok) {
                emit Paid(recipient, amount);
                return;
            }
        } catch {}
        pendingWithdrawals[recipient] += amount;
        emit WithdrawalCredited(recipient, amount);
    }

    function _release(uint256 escrowId, uint256 milestoneId) internal {
        Milestone storage m = _escrows[escrowId].milestones[milestoneId];
        if (m.status != MilestoneStatus.Funded && m.status != MilestoneStatus.Delivered)
            revert MilestoneNotReleasable();

        uint256 amount = m.amount;
        address payee_ = _escrows[escrowId].payee;

        // CEI: update state before paying
        m.status = MilestoneStatus.Released;
        _pay(payee_, amount);

        emit MilestoneReleased(escrowId, milestoneId, amount);
        _checkAllMilestonesResolved(escrowId);
    }

    /**
     * @dev Mutual-cancel path: refunds Funded + Delivered milestones to payer.
     *      Both parties consented, so Delivered milestones are also refunded.
     *      Disputed milestones are excluded — arbitrator must resolve them.
     */
    function _cancelAndRefundNonDisputed(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        uint256 refund = 0;

        for (uint256 i = 0; i < e.milestones.length; i++) {
            MilestoneStatus ms = e.milestones[i].status;
            if (ms == MilestoneStatus.Funded || ms == MilestoneStatus.Delivered) {
                refund += e.milestones[i].amount;
                e.milestones[i].status = MilestoneStatus.Refunded;
            }
        }

        emit EscrowCancelled(escrowId, refund);
        if (refund > 0) _pay(e.payer, refund);

        // If disputes remain, escrow stays Active so resolveDispute() can still run.
        _checkAllMilestonesResolved(escrowId);
    }

    /**
     * @dev Timeout path: refunds ONLY Funded (undelivered) milestones to payer.
     *      Delivered milestones are intentionally skipped — payee already signalled completion
     *      (they can be released by the payer or claimed via claimAfterReview()).
     *      Disputed milestones must be resolved by the arbitrator.
     */
    function _timeoutRefundFundedOnly(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        uint256 refund = 0;

        for (uint256 i = 0; i < e.milestones.length; i++) {
            if (e.milestones[i].status == MilestoneStatus.Funded) {
                refund += e.milestones[i].amount;
                e.milestones[i].status = MilestoneStatus.Refunded;
            }
        }

        emit EscrowCancelled(escrowId, refund);
        if (refund > 0) _pay(e.payer, refund);
        _checkAllMilestonesResolved(escrowId);
    }

    /**
     * @dev Closes the escrow once every milestone is terminal (Released, Refunded or
     *      Resolved): Completed if any money reached the payee side, Cancelled if everything
     *      was refunded. Called after every settlement.
     */
    function _checkAllMilestonesResolved(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        bool anySettled = false;
        for (uint256 i = 0; i < e.milestones.length; i++) {
            MilestoneStatus ms = e.milestones[i].status;
            if (ms == MilestoneStatus.Released || ms == MilestoneStatus.Resolved) {
                anySettled = true;
            } else if (ms != MilestoneStatus.Refunded) {
                return; // still open
            }
        }
        if (anySettled) {
            e.status = EscrowStatus.Completed;
            emit EscrowCompleted(escrowId);
        } else {
            e.status = EscrowStatus.Cancelled;
        }
    }
}
