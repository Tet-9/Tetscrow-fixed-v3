/**
 * Tetscrow — wallet + on-chain helpers
 *
 * Wallet: EIP-6963 provider discovery (any injected browser wallet that supports Arc).
 * Chain:  Arc only (testnet or mainnet, as configured in config.js).
 * Token:  USDC-only (Arc predeploy at 0x3600...0000, 6 decimals).
 *
 * IMPORTANT (Arc): USDC is ALSO the gas token. Every wallet that sends a transaction —
 * including a receiver who only wants to Withdraw / Mark Delivered — needs a little USDC
 * for fees. Helpers below check for that and explain it instead of failing obscurely.
 *
 * Payouts: releaseMilestone / claimAfterReview / resolveDispute send USDC straight to the
 * recipient. If that direct transfer fails, it is credited to pendingWithdrawals and the
 * recipient collects it with withdraw() (see mountWithdrawPanel).
 */
const Tetscrow = (() => {
  "use strict";

  let provider, signer, connectedAddress, activeEip1193;
  const found = new Map(); // rdns -> { info, provider }
  let listenersBound = false;
  const DISCONNECT_FLAG = "tetscrow_disconnected"; // set by Disconnect so a reload doesn't silently reconnect

  // ---- Display helpers ----
  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }

  /**
   * Elegant USDC display. Accepts a raw bigint (6 decimals) or a decimal string/number.
   * Truncates (never rounds up), keeps 2–4 decimals, adds thousands separators, and never
   * shows the raw 6/18-decimal contract value. Dust below 0.0001 shows up to 6 decimals
   * so a tiny non-zero amount is never displayed as 0.00.
   */
  function fmtAmount(value, maxDp, minDp) {
    maxDp = maxDp === undefined ? 4 : maxDp;
    minDp = minDp === undefined ? 2 : minDp;
    let s;
    if (value === null || value === undefined || value === "") s = "0";
    else if (typeof value === "bigint") {
      const dec = (window.TETSCROW_CONFIG && window.TETSCROW_CONFIG.USDC_DECIMALS) || 6;
      const base = 10n ** BigInt(dec);
      const neg = value < 0n; const abs = neg ? -value : value;
      s = (neg ? "-" : "") + (abs / base).toString() + "." + (abs % base).toString().padStart(dec, "0");
    } else s = String(value).trim();
    if (!/^-?\d*\.?\d*$/.test(s) || s === "" || s === "-" || s === ".") {
      const n = Number(s);
      s = Number.isFinite(n) ? n.toFixed(6) : "0";
    }
    const neg = s.startsWith("-");
    if (neg) s = s.slice(1);
    let parts = s.split(".");
    let whole = (parts[0] || "0").replace(/^0+(?=\d)/, "") || "0";
    let frac = parts[1] || "";
    let shown = frac.slice(0, maxDp).replace(/0+$/, "");
    if (whole === "0" && shown === "" && /[1-9]/.test(frac)) shown = frac.slice(0, 6).replace(/0+$/, ""); // dust
    while (shown.length < minDp) shown += "0";
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg && /[1-9]/.test(whole + shown) ? "-" : "") + whole + "." + shown;
  }

  function emitWallet() {
    window.dispatchEvent(new CustomEvent("tetscrow:wallet", { detail: { connected: !!connectedAddress, address: connectedAddress || null } }));
  }

  // ---- EIP-6963 wallet discovery ----
  window.addEventListener("eip6963:announceProvider", (e) => {
    found.set(e.detail.info.rdns, e.detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function anyInjected() {
    if (found.size) return found.values().next().value.provider;
    return window.ethereum || null;
  }

  async function pickEip1193(opts = {}) {
    if (!found.size) await new Promise((r) => setTimeout(r, 120));
    return anyInjected();
  }

  // ---- Error helper: turn wallet / contract errors into readable text ----
  const ERROR_TEXT = {
    NotPayer: "Only the payer (sender) can do this.",
    NotPayee: "Only the receiver can do this.",
    NotParty: "Only the sender or receiver can do this.",
    NotArbitrator: "Only the arbitrator can do this.",
    EscrowNotActive: "This escrow is no longer active.",
    MilestoneNotReleasable: "This milestone can't be released in its current state.",
    MilestoneNotDeliverable: "This milestone can't be marked delivered in its current state.",
    MilestoneNotDisputable: "This milestone can't be disputed in its current state.",
    MilestoneNotDisputed: "This milestone is not in dispute.",
    InvalidMilestone: "That milestone number doesn't exist.",
    DeadlineNotReached: "The deadline hasn't passed yet.",
    ReviewPeriodNotOver: "The payer's review period hasn't ended yet.",
    NothingToWithdraw: "There is nothing to withdraw.",
    AlreadyInitiatedCancel: "You already requested cancellation.",
    SelfEscrow: "You can't create an escrow with yourself as receiver.",
    DeadlineInPast: "The deadline must be in the future.",
    SharesMismatch: "The shares must add up to the milestone amount.",
  };

  function explainError(err) {
    if (!err) return "Unknown error";
    if (err.code === 4001 || err.code === "ACTION_REJECTED") return "You rejected the request in your wallet.";
    const name = err.revert && err.revert.name;
    if (name && ERROR_TEXT[name]) return ERROR_TEXT[name];
    const msg = err.shortMessage || err.reason || err.message || String(err);
    if (/insufficient funds/i.test(msg))
      return "Your wallet has no USDC to pay the network fee. On Arc, gas is paid in USDC — top up first" +
        (window.TETSCROW_CONFIG.FAUCET ? " (" + window.TETSCROW_CONFIG.FAUCET + ")." : ".");
    return msg;
  }

  // ---- Network handling ----
  async function addArcNetwork(eip1193) {
    const C = window.TETSCROW_CONFIG;
    await eip1193.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: C.CHAIN_ID_HEX,
        chainName: C.CHAIN_NAME,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // Arc's native gas token
        rpcUrls: C.RPC_URLS,
        blockExplorerUrls: [C.EXPLORER],
      }],
    });
  }

  async function currentChainId(eip1193) {
    return parseInt(await eip1193.request({ method: "eth_chainId" }), 16);
  }

  async function ensureChain(eip1193) {
    const C = window.TETSCROW_CONFIG;
    if ((await currentChainId(eip1193)) === C.CHAIN_ID) return;
    try {
      await eip1193.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.CHAIN_ID_HEX }] });
    } catch (switchErr) {
      if (switchErr.code === 4902 || switchErr.code === -32603) {
        await addArcNetwork(eip1193); // adding normally also switches; verify below
      } else {
        throw new Error("Please switch your wallet to " + C.CHAIN_NAME + " (chain " + C.CHAIN_ID + ") to continue.");
      }
    }
    if ((await currentChainId(eip1193)) !== C.CHAIN_ID)
      throw new Error("Your wallet is not on " + C.CHAIN_NAME + " (chain " + C.CHAIN_ID + ").");
  }

  function bindListeners(eip1193) {
    if (listenersBound || !eip1193.on) return;
    listenersBound = true;
    eip1193.on("accountsChanged", (accs) => {
      const next = (accs && accs[0] || "").toLowerCase();
      const stored = (localStorage.getItem("tetscrow_wallet") || "").toLowerCase();
      if (stored && next !== stored) {
        localStorage.removeItem("tetscrow_jwt");
        localStorage.removeItem("tetscrow_wallet");
      }
      location.reload();
    });
    eip1193.on("chainChanged", () => location.reload());
  }

  async function buildSigner(eip1193) {
    provider = new ethers.BrowserProvider(eip1193); // built AFTER the chain switch
    signer = await provider.getSigner();
    connectedAddress = await signer.getAddress();
    activeEip1193 = eip1193;
    bindListeners(eip1193);
    paintWallet();
    return connectedAddress;
  }

  // ---- Connect wallet (user-initiated: may open wallet popups) ----
  async function connectWallet(opts = {}) {
    if (connectedAddress && signer) {
      await ensureChain(activeEip1193);
      return connectedAddress;
    }
    const eip1193 = await pickEip1193(opts);
    if (!eip1193) throw new Error("No wallet found. Install a browser wallet that supports the Arc network to continue.");
    await eip1193.request({ method: "eth_requestAccounts" });
    await ensureChain(eip1193);
    try { localStorage.removeItem(DISCONNECT_FLAG); } catch (e) { /* storage blocked */ }
    const addr = await buildSigner(eip1193);
    emitWallet();
    return addr;
  }

  /** Forget the wallet in this app (a browser wallet can't be force-disconnected by a site). */
  async function disconnectWallet() {
    try { localStorage.setItem(DISCONNECT_FLAG, "1"); } catch (e) { /* storage blocked */ }
    localStorage.removeItem("tetscrow_jwt");
    localStorage.removeItem("tetscrow_wallet");
    const eip = activeEip1193;
    provider = signer = connectedAddress = activeEip1193 = undefined;
    _readProvider = undefined;
    try { if (eip && eip.request) await eip.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); }
    catch (e) { /* not supported by every wallet — the app-level disconnect above still applies */ }
    paintWallet();
    emitWallet();
  }

  /** Connect + (if needed) sign in to the backend. Used by every Connect Wallet button. */
  async function connectAndSignIn() {
    await connectWallet();
    if (!hasValidSession()) await signInWithModal();
    return connectedAddress;
  }

  /** The "Verify your account" dialog: Preparing message... -> [Sign message] -> Waiting for signature... */
  async function signInWithModal() {
    const overlay = document.createElement("div");
    overlay.className = "vmodal-overlay";
    overlay.innerHTML =
      '<div class="vmodal" role="dialog" aria-modal="true" aria-labelledby="vm-title">' +
      '<button type="button" class="vmodal-x" aria-label="Close">&times;</button>' +
      '<div class="vmodal-ico" aria-hidden="true">&#128221;</div>' +
      '<h3 id="vm-title">Verify your account</h3>' +
      '<p>To finish connecting, you must sign a message in your wallet to verify that you are the owner of this account.</p>' +
      '<button type="button" class="vmodal-btn" data-vm-main disabled>Preparing message...</button>' +
      '<button type="button" class="vmodal-cancel" data-vm-cancel>Cancel</button></div>';
    document.body.appendChild(overlay);
    const main = overlay.querySelector("[data-vm-main]");
    const close = () => overlay.remove();
    let rejectClick;
    const cancelled = new Promise((_, rej) => { rejectClick = rej; });
    const cancel = () => rejectClick(new Error("Sign-in cancelled."));
    overlay.querySelector("[data-vm-cancel]").onclick = cancel;
    overlay.querySelector(".vmodal-x").onclick = cancel;
    try {
      await Promise.race([
        signInWithWallet({
          onPreparing: () => { main.disabled = true; main.textContent = "Preparing message..."; },
          beforeSign: () => new Promise((resolve) => {
            main.disabled = false; main.textContent = "Sign message"; main.classList.add("ready");
            main.onclick = () => resolve();
          }),
          onSigning: () => { main.disabled = true; main.classList.remove("ready"); main.textContent = "Waiting for signature..."; },
        }),
        cancelled,
      ]);
    } finally { close(); }
    paintWallet();
    emitWallet();
  }

  /**
   * Sign an off-chain action (accept a milestone, request/approve a deadline, dispute steps...).
   * Free (no gas); the backend recomputes the same text and checks the signature.
   */
  async function signAction(action, ref, data) {
    await connectWallet();
    const ts = Date.now();
    const text = "Tetscrow action: " + action + "\nWallet: " + connectedAddress.toLowerCase() +
      "\nRef: " + ref + "\nData: " + (data === undefined ? "" : data) + "\nTime: " + ts;
    const signature = await signer.signMessage(text);
    return { ts, signature };
  }

  // ---- Silent restore on page load: never opens a popup ----
  async function restoreSession() {
    try {
      if (localStorage.getItem(DISCONNECT_FLAG)) { paintWallet(); return null; }
      const eip1193 = await pickEip1193();
      if (!eip1193) { paintWallet(); return null; }
      const accounts = await eip1193.request({ method: "eth_accounts" });
      if (!accounts || !accounts.length) { paintWallet(); return null; }
      if ((await currentChainId(eip1193)) !== window.TETSCROW_CONFIG.CHAIN_ID) { paintWallet(); return null; } // don't nag on load
      const addr = await buildSigner(eip1193);
      emitWallet();
      return addr;
    } catch (e) {
      console.warn("Tetscrow: could not restore wallet session:", e.message);
      return null;
    }
  }

  /**
   * One place that draws every wallet control on the page:
   *   [data-wallet-btn]   -> "Connect Wallet" / "Disconnect"
   *   [data-wallet-pill]  -> "Not connected" / "Wallet connected" + short address
   *   [data-wallet-short] -> just the short address (or empty)
   */
  function paintWallet() {
    const addr = connectedAddress;
    document.querySelectorAll("[data-wallet-btn]").forEach((el) => {
      el.textContent = addr ? "Disconnect" : "Connect Wallet";
      el.classList.toggle("is-connected", !!addr);
      el.setAttribute("aria-label", addr ? "Disconnect wallet " + addr : "Connect wallet");
      el.title = addr || "";
    });
    document.querySelectorAll("[data-wallet-pill]").forEach((el) => {
      el.classList.toggle("connected", !!addr);
      if (el.hasAttribute("data-pill-inline")) {
        el.hidden = !addr;
        el.innerHTML = addr ? '<span class="dot"></span><span class="pill-addr">' + shortAddr(addr) + "</span>" : "";
      } else {
        el.innerHTML = addr
          ? '<span class="pill-top"><span class="dot"></span>Wallet connected</span><span class="pill-addr">' + shortAddr(addr) + "</span>"
          : '<span class="pill-top"><span class="dot off"></span>Not connected</span>';
      }
      if (addr) el.title = addr;
    });
    document.querySelectorAll("[data-wallet-short]").forEach((el) => { el.textContent = addr ? shortAddr(addr) : ""; });
  }

  // Delegated so buttons drawn later (gates, panels) work too.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("[data-wallet-btn]");
    if (!b || b.disabled) return;
    e.preventDefault();
    b.disabled = true;
    try {
      if (connectedAddress) await disconnectWallet();
      else await connectAndSignIn();
    } catch (err) {
      const msg = explainError(err);
      if (window.TetscrowSite && window.TetscrowSite.toast) window.TetscrowSite.toast(msg); else alert(msg);
    } finally { b.disabled = false; paintWallet(); }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paintWallet);
  else paintWallet();

  // ---- Wallet sign-in (a signed message proves wallet ownership to the backend) ----
  function hasValidSession() {
    const w = (localStorage.getItem("tetscrow_wallet") || "").toLowerCase();
    return !!localStorage.getItem("tetscrow_jwt") && (!connectedAddress || w === connectedAddress.toLowerCase());
  }

  async function signInWithWallet(hooks) {
    hooks = hooks || {};
    const addr = await connectWallet();
    const base = window.TETSCROW_CONFIG.API_BASE;
    if (hooks.onPreparing) hooks.onPreparing();

    let nonceRes;
    try {
      nonceRes = await fetch(base + "/auth/nonce/" + addr);
    } catch (e) {
      throw new Error("Can't reach the Tetscrow server at " + base + ". Is the backend running?");
    }
    if (!nonceRes.ok) throw new Error("Sign-in failed: " + (await nonceRes.text()));
    const { nonce } = await nonceRes.json();

    const message = "Sign in to Tetscrow.\n\nWallet: " + addr + "\nNonce: " + nonce;
    if (hooks.beforeSign) await hooks.beforeSign(); // the "Sign message" button of the verify modal
    if (hooks.onSigning) hooks.onSigning();
    const signature = await signer.signMessage(message);

    const verifyRes = await fetch(base + "/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: addr, signature, message }),
    });
    if (!verifyRes.ok) throw new Error("Sign-in failed: " + (await verifyRes.text()));
    const { access_token } = await verifyRes.json();
    localStorage.setItem("tetscrow_jwt", access_token);
    localStorage.setItem("tetscrow_wallet", addr);
    return access_token;
  }

  // ---- Contract accessors ----
  let _readProvider;
  function readRunner() {
    if (provider) return provider;
    if (!_readProvider) {
      const C = window.TETSCROW_CONFIG;
      _readProvider = new ethers.JsonRpcProvider(C.RPC_URL, C.CHAIN_ID, { staticNetwork: ethers.Network.from(C.CHAIN_ID) });
    }
    return _readProvider;
  }

  function requireEscrowAddress() {
    const a = window.TETSCROW_CONFIG.TETSCROW_ESCROW_ADDRESS;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a || "")) throw new Error("TETSCROW_ESCROW_ADDRESS is not set in js/config.js");
    return a;
  }

  function getEscrowContract(withSigner = true) {
    const runner = withSigner ? signer : readRunner();
    if (withSigner && !signer) throw new Error("Connect your wallet first.");
    return new ethers.Contract(requireEscrowAddress(), window.TETSCROW_ESCROW_ABI, runner);
  }

  function getUsdcContract(withSigner = true) {
    const runner = withSigner ? signer : readRunner();
    if (withSigner && !signer) throw new Error("Connect your wallet first.");
    return new ethers.Contract(window.TETSCROW_CONFIG.USDC_ADDRESS, window.USDC_ABI, runner);
  }

  // ---- USDC helpers ----
  function parseUsdc(amount) {
    return ethers.parseUnits(String(amount), window.TETSCROW_CONFIG.USDC_DECIMALS);
  }
  /** Display string: truncated, separators, 2–4 decimals. NEVER send this to a server/contract. */
  function formatUsdc(raw) { return fmtAmount(raw); }
  /** Exact decimal string for storage / APIs (full 6-decimal precision, trailing zeros trimmed). */
  function formatUsdcExact(raw) {
    const t = ethers.formatUnits(raw, window.TETSCROW_CONFIG.USDC_DECIMALS);
    return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
  }
  async function usdcBalance(owner) {
    return getUsdcContract(false).balanceOf(owner || connectedAddress);
  }
  async function usdcAllowance(owner, spender) {
    return getUsdcContract(false).allowance(owner || connectedAddress, spender);
  }
  /** Native balance = the gas balance (USDC, 18 decimals on Arc). */
  async function gasBalance(owner) {
    return readRunner().getBalance(owner || connectedAddress);
  }

  async function requireGas() {
    const bal = await gasBalance();
    if (bal === 0n) {
      const f = window.TETSCROW_CONFIG.FAUCET;
      throw new Error("This wallet has no USDC for network fees. On Arc, gas is paid in USDC, so even receiving/withdrawing needs a small balance." +
        (f ? " Get testnet USDC at " + f + "." : ""));
    }
  }

  async function ensureUsdcApproval(amountRaw) {
    const escrowAddr = requireEscrowAddress();
    const current = await usdcAllowance(connectedAddress, escrowAddr);
    if (current < amountRaw) {
      const tx = await getUsdcContract(true).approve(escrowAddr, amountRaw);
      await tx.wait();
    }
  }

  /** Run a state-changing call with wallet + chain + gas checks. Returns the receipt. */
  async function sendTx(fn) {
    await connectWallet();
    await requireGas();
    const tx = await fn(getEscrowContract(true));
    const receipt = await tx.wait();
    if (receipt && receipt.status === 0) throw new Error("Transaction failed on-chain.");
    return receipt;
  }

  // ---- High-level escrow actions ----
  async function createEscrow({ payee, milestones, deadlineTs }) {
    if (!milestones || milestones.length === 0) throw new Error("At least one milestone required");
    await connectWallet();
    await requireGas();

    const inputs = milestones.map((m) => ({
      descriptionHash: ethers.keccak256(ethers.toUtf8Bytes(m.description || "")),
      amount: parseUsdc(m.amount),
    }));
    const totalRaw = inputs.reduce((sum, m) => sum + m.amount, 0n);

    const bal = await usdcBalance();
    if (bal < totalRaw)
      throw new Error("Not enough USDC: you have " + formatUsdc(bal) + " but need " + formatUsdc(totalRaw) + " (plus a little for fees).");

    await ensureUsdcApproval(totalRaw);

    const contract = getEscrowContract(true);
    const receipt = await (await contract.createEscrow(payee, inputs, deadlineTs)).wait();

    const log = receipt.logs
      .filter((l) => l.address.toLowerCase() === requireEscrowAddress().toLowerCase())
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "EscrowCreated");
    if (!log) throw new Error("EscrowCreated event not found in receipt");
    return { escrowId: Number(log.args.escrowId), txHash: receipt.hash };
  }

  const markDelivered        = (id, m) => sendTx((c) => c.markDelivered(id, m));
  const releaseMilestone     = (id, m) => sendTx((c) => c.releaseMilestone(id, m));
  const claimAfterReview     = (id, m) => sendTx((c) => c.claimAfterReview(id, m));
  const raiseDispute         = (id, m) => sendTx((c) => c.raiseDispute(id, m));
  const initiateMutualCancel = (id)    => sendTx((c) => c.initiateMutualCancel(id));
  const claimTimeout         = (id)    => sendTx((c) => c.claimTimeout(id));
  const resolveDispute       = (id, m, payerShare, payeeShare) =>
    sendTx((c) => c.resolveDispute(id, m, parseUsdc(payerShare), parseUsdc(payeeShare)));
  const withdrawUsdc         = ()      => sendTx((c) => c.withdraw());

  async function pendingWithdrawal(address) {
    const who = address || connectedAddress;
    if (!who) return 0n;
    return getEscrowContract(false).pendingWithdrawals(who);
  }

  // ---- Live on-chain reads (no backend needed) ----
  async function getOnchainEscrow(onchainId) {
    const c = getEscrowContract(false);
    const e = await c.getEscrow(onchainId);
    const count = Number(e.milestoneCount);
    const legacy = new ethers.Contract(requireEscrowAddress(), window.TETSCROW_ESCROW_ABI_LEGACY, readRunner());
    const milestones = [];
    for (let i = 0; i < count; i++) {
      let m;
      try { m = await c.getMilestone(onchainId, i); }
      catch { m = await legacy.getMilestone(onchainId, i); } // older deployment without deliveredAt
      milestones.push({
        id: i,
        amount: m.amount,
        status: Number(m.status),
        deliveredAt: m.deliveredAt !== undefined ? Number(m.deliveredAt) : 0,
      });
    }
    return {
      payer: e.payer.toLowerCase(),
      payee: e.payee.toLowerCase(),
      deadline: Number(e.deadline),
      status: Number(e.status),
      payerCancelIntent: e.payerCancelIntent,
      payeeCancelIntent: e.payeeCancelIntent,
      milestones,
    };
  }

  async function reviewPeriodSeconds() {
    try { return Number(await getEscrowContract(false).REVIEW_PERIOD()); }
    catch { return 0; } // 0 = this deployment has no claimAfterReview
  }

  /**
   * Renders "Your balance" + Withdraw button into `el`. Works for any connected wallet, on any
   * page, without signing in to the backend — so a receiver can always collect their funds.
   */
  async function mountWithdrawPanel(el, opts = {}) {
    if (!el) return;
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const C = window.TETSCROW_CONFIG;
    async function draw(msg, isErr) {
      if (!connectedAddress) {
        el.innerHTML = '<div class="wd-box"><b>Received funds</b><p>Connect your wallet to see any USDC waiting for you.</p>' +
          '<button type="button" class="btn btn-primary btn-sm" data-wd-connect>Connect wallet</button></div>';
        el.querySelector("[data-wd-connect]").onclick = async () => {
          try { await connectWallet(); if (opts.onConnect) opts.onConnect(); draw(); }
          catch (e) { draw(explainError(e), true); }
        };
        return;
      }
      let pending = 0n, gas = 0n, usdc = 0n, note = "";
      try {
        [pending, gas, usdc] = await Promise.all([pendingWithdrawal(), gasBalance(), usdcBalance()]);
      } catch (e) { note = "Couldn't read balances: " + explainError(e); }
      const has = pending > 0n;
      const lowGas = gas === 0n;
      el.innerHTML =
        '<div class="wd-box"><b>Your USDC</b>' +
        '<div class="wd-row"><span>Wallet balance</span><b>' + esc(fmtAmount(usdc)) + ' USDC</b></div>' +
        '<div class="wd-row"><span>Waiting to withdraw</span><b>' + esc(fmtAmount(pending)) + ' USDC</b></div>' +
        (has ? '<button type="button" class="btn btn-primary btn-sm" data-wd-go>Withdraw ' + esc(fmtAmount(pending)) + ' USDC</button>'
             : '<p class="wd-hint">Released payments are sent straight to your wallet. Anything that could not be sent directly appears here.</p>') +
        (lowGas ? '<p class="wd-err">This wallet has no USDC for network fees. Arc uses USDC as gas, so you need a small balance to send any transaction' +
                  (C.FAUCET ? ' — <a href="' + esc(C.FAUCET) + '" target="_blank" rel="noopener">get some from the faucet</a>' : '') + '.</p>' : '') +
        (msg ? '<p class="' + (isErr ? 'wd-err' : 'wd-ok') + '">' + esc(msg) + '</p>' : '') +
        (note ? '<p class="wd-err">' + esc(note) + '</p>' : '') +
        '</div>';
      const go = el.querySelector("[data-wd-go]");
      if (go) go.onclick = async () => {
        go.disabled = true; go.textContent = "Withdrawing…";
        try { await withdrawUsdc(); await draw("Withdrawn to your wallet.", false); if (opts.onChange) opts.onChange(); }
        catch (e) { await draw(explainError(e), true); }
      };
    }
    await draw();
    return draw;
  }

  return {
    connectWallet,
    restoreSession,
    signInWithWallet,
    signInWithModal,
    signAction,
    hasValidSession,
    explainError,
    getEscrowContract,
    getUsdcContract,
    disconnectWallet,
    connectAndSignIn,
    paintWallet,
    shortAddr,
    fmtAmount,
    getAddress: () => connectedAddress,
    listWallets: () => Array.from(found.values()).map((d) => d.info),
    // USDC
    parseUsdc,
    formatUsdc,
    formatUsdcExact,
    usdcBalance,
    usdcAllowance,
    gasBalance,
    ensureUsdcApproval,
    // Escrow actions
    createEscrow,
    markDelivered,
    releaseMilestone,
    claimAfterReview,
    initiateMutualCancel,
    claimTimeout,
    raiseDispute,
    resolveDispute,
    withdrawUsdc,
    pendingWithdrawal,
    // Reads / UI
    getOnchainEscrow,
    reviewPeriodSeconds,
    mountWithdrawPanel,
  };
})();
