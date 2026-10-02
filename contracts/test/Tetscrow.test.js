const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => ethers.parseUnits(String(n), 6);
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("Tetscrow", () => {
  let usdc, esc, owner, arb, payer, payee, other, deadline;

  beforeEach(async () => {
    [owner, arb, payer, payee, other] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    esc = await (await ethers.getContractFactory("Tetscrow")).deploy(await usdc.getAddress(), arb.address, owner.address);
    await usdc.mint(payer.address, U(1000));
    await usdc.connect(payer).approve(await esc.getAddress(), U(1000));
    deadline = (await time.latest()) + 30 * 86400;
    await esc.connect(payer).createEscrow(payee.address, [
      { descriptionHash: h("a"), amount: U(100) },
      { descriptionHash: h("b"), amount: U(50) },
    ], deadline);
  });

  it("locks funds on create", async () => {
    expect(await usdc.balanceOf(await esc.getAddress())).to.equal(U(150));
  });

  it("pays the receiver directly on release", async () => {
    await esc.connect(payee).markDelivered(1, 0);
    await esc.connect(payer).releaseMilestone(1, 0);
    expect(await usdc.balanceOf(payee.address)).to.equal(U(100));
    expect(await esc.pendingWithdrawals(payee.address)).to.equal(0);
  });

  it("falls back to withdraw() when the direct transfer fails", async () => {
    await usdc.setBlocked(payee.address, true);
    await esc.connect(payer).releaseMilestone(1, 0);
    expect(await esc.pendingWithdrawals(payee.address)).to.equal(U(100));
    await usdc.setBlocked(payee.address, false);
    await esc.connect(payee).withdraw();
    expect(await usdc.balanceOf(payee.address)).to.equal(U(100));
  });

  it("lets the payee claim after the review period", async () => {
    await esc.connect(payee).markDelivered(1, 0);
    await expect(esc.connect(payee).claimAfterReview(1, 0)).to.be.revertedWithCustomError(esc, "ReviewPeriodNotOver");
    await time.increase(7 * 86400 + 1);
    await esc.connect(payee).claimAfterReview(1, 0);
    expect(await usdc.balanceOf(payee.address)).to.equal(U(100));
  });

  it("refunds only Funded milestones on timeout", async () => {
    await esc.connect(payee).markDelivered(1, 0);
    await time.increaseTo(deadline + 1);
    await esc.claimTimeout(1);
    expect(await usdc.balanceOf(payer.address)).to.equal(U(900)); // 1000-150+50 (milestone 1 refunded)
    const m = await esc.getMilestone(1, 0);
    expect(m.status).to.equal(1); // still Delivered
  });

  it("arbitrator splits a dispute", async () => {
    await esc.connect(payee).raiseDispute(1, 0);
    await esc.connect(arb).resolveDispute(1, 0, U(40), U(60));
    expect(await usdc.balanceOf(payee.address)).to.equal(U(60));
    await expect(esc.connect(arb).resolveDispute(1, 0, U(40), U(60))).to.be.reverted;
  });

  it("completes when all milestones settle", async () => {
    await esc.connect(payer).releaseMilestone(1, 0);
    await esc.connect(payer).releaseMilestone(1, 1);
    const e = await esc.getEscrow(1);
    expect(e.status).to.equal(1); // Completed
  });

  it("mutual cancel refunds both open milestones", async () => {
    await esc.connect(payer).initiateMutualCancel(1);
    await esc.connect(payee).initiateMutualCancel(1);
    expect(await usdc.balanceOf(payer.address)).to.equal(U(1000));
    expect((await esc.getEscrow(1)).status).to.equal(2); // Cancelled
  });

  it("rejects bad milestone ids and self-escrow", async () => {
    await expect(esc.connect(payer).releaseMilestone(1, 9)).to.be.revertedWithCustomError(esc, "InvalidMilestone");
    await expect(esc.connect(payer).createEscrow(payer.address, [{ descriptionHash: h("x"), amount: U(1) }], deadline))
      .to.be.revertedWithCustomError(esc, "SelfEscrow");
  });
});
