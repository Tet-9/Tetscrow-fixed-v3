# Tetscrow — Decentralized & Secure Escrow on Arc

Milestone-based **USDC** escrow on Arc (Circle's L1): Solidity contract, FastAPI backend, static wallet-connected frontend.

```
contracts/   Hardhat project. contracts/contracts/Tetscrow.sol (contract "Tetscrow"), tests in contracts/test
backend/     FastAPI — wallet-signature auth, off-chain metadata, dispute notes, live chain reads. Never holds keys/funds.
frontend/    Static site, no build step. Landing pages + app/ (dashboard, create, escrow-detail, disputes)
```

## How money moves (and why the receiver may not "see" it)

1. Sender approves + deposits USDC → `createEscrow` (milestones).
2. Receiver `markDelivered`. Sender `releaseMilestone` → **USDC is sent straight to the receiver's wallet**.
   If a direct transfer is impossible (e.g. the address is USDC-blocklisted) it is credited to `pendingWithdrawals`
   and the receiver clicks **Withdraw** (dashboard, app home, or the escrow page).
3. If the sender goes silent after delivery, the receiver can `claimAfterReview` once `REVIEW_PERIOD` (7 days) has passed.
4. Disputes freeze a milestone; the on-chain `arbitrator` splits it with `resolveDispute`.

**Arc gas is USDC.** Any wallet that sends a transaction (mark delivered, withdraw, …) needs a small USDC balance for fees.
The UI now checks this and says so instead of failing silently. Testnet USDC: https://faucet.circle.com

## Setup

1. **Contracts**
   ```
   cd contracts && npm install
   cp .env.example .env        # DEPLOYER_PRIVATE_KEY, optional ARBITRATOR_ADDRESS / OWNER_ADDRESS
   npx hardhat test
   npx hardhat run scripts/deploy.js --network arcTestnet     # or arcMainnet
   ```
   Put the printed address in `backend/.env` (`TETSCROW_ESCROW_ADDRESS`) **and** `frontend/js/config.js` (`escrowAddress`).
   Contract changed in this version → it must be **re-deployed**; old escrows stay on the old contract.

2. **Backend**
   ```
   cd backend && pip install -r requirements.txt
   cp .env.example .env        # set TETSCROW_ESCROW_ADDRESS, JWT_SECRET
   uvicorn app.main:app --reload
   ```
3. **Frontend**: `cd frontend && python -m http.server 5173` → open http://localhost:5173

## Mainnet
Set `NETWORK = "mainnet"` and `escrowAddress` under `mainnet` in `frontend/js/config.js`, `RPC_URL`/`CHAIN_ID=5042` in `backend/.env`.
Get an independent audit first — this contract is unaudited.

## Notes
- `SKIP_ONCHAIN_VERIFY=1` (backend, dev only) skips checking records against the chain.
- Swap SQLite for Postgres and the in-memory nonce store for Redis before running multiple instances.
- Press cards and outside links are configured in `frontend/js/site-config.js`; add only real coverage.
- USDC amounts are displayed truncated to 2–4 decimals (e.g. `100.1234`, `2.50`); the exact 6-decimal value is always kept on-chain and is what gets stored by the backend.
- Every page has one Connect Wallet button; once connected it becomes **Disconnect** and a "Wallet connected" pill shows the short address.
- `frontend/assets/*` (mascot stills + `hero/` frames) were regenerated with `tools/render_all.py` and `tools/render_hero.py` (numpy + Pillow only) because the previous copies were corrupted.


## How the app works (v3)

Same mechanisms and layout as the Crow reference, on **Arc + USDC only** (no other chains or tokens).

1. **Connect Wallet** -> "Verify your account" dialog (Preparing message -> Sign message -> Waiting for signature). The header then shows the network chip (Arc Testnet), your USDC balance, your short address and a **Disconnect** button.
2. **Dashboard** -> profile card (name, picture, address, Total Paid, Assets in Escrows, Total Jobs, Total Disputes), Sort By, **My Jobs / My Disputes**, **Create a Job**. **edit** opens Edit Profile (name up to 15 characters, picture, Save and Update).
3. **Create Job** -> step 1 title + description, step 2 amount, deadline, worker wallet, optional secondary wallet, **Create** (USDC approval, then deposit).
4. **Job page** -> chat with file attachments, description (More/Less), milestones (All/Completed), progress bar.
   - Worker: **Accept** (gasless signature), **Submit for Approval** (on-chain `markDelivered`), **Request Extension**, **Raise a Dispute**, **Claim Payment** after the 7-day review window.
   - Buyer: **Create Milestone** (Approve, then Create), **Update** deadline, **Approve** an extension, **Approve Milestone Delivery** (on-chain release), **Raise a Dispute**.
5. **Dispute page** -> Challenge / Modify / Settle (gasless signatures), Invite Support Team after 7 days. The arbitrator releases the agreed split on-chain with `resolveDispute`.

### What is on-chain and what is not
- On-chain (contract unchanged): funding, delivery, release, dispute freeze, arbitrator split, mutual cancel, timeout refund, withdrawals.
- Off-chain, in the backend, each confirmed with a free wallet signature: accepting a milestone, per-milestone deadlines and extensions, dispute challenge/modify/settle/support invite, chat, profiles.
- Each milestone is its own on-chain escrow under one job. The on-chain refund date is set 30 days after the job deadline so approved extensions fit.
- There are no platform fees: the contract does not charge any, so none are shown.
- Because the deployed contract only lets the arbitrator split a disputed milestone, **Settle** records the agreement and the arbitrator then releases the funds. A mutual-settle function would need a contract change and redeploy.
