/* Shared UI for the app pages: header, avatars, modals, small helpers. Needs wallet.js + api.js loaded first. */
const App = (() => {
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "");
  const fmt = (v) => Tetscrow.fmtAmount(v);

  // Default avatar: a little yellow duck (used until the person uploads a picture)
  const DUCK = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/>' +
    '<path d="M18 62c0-14 10-22 24-22 2-12 10-20 22-20 10 0 16 8 14 18l8 4-8 4c-1 18-14 34-32 34-16 0-28-8-28-18z" fill="#ffe229" stroke="#000" stroke-width="3" stroke-linejoin="round"/>' +
    '<circle cx="68" cy="34" r="3.5" fill="#000"/><path d="M78 36l10 2-9 5z" fill="#e63232" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M36 66c6 8 18 8 26 0" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/></svg>');

  function avatarImg(profile, px) {
    const src = (profile && profile.avatar) || DUCK;
    return `<span class="av" style="width:${px}px;height:${px}px"><img class="avatar" src="${esc(src)}" alt=""></span>`;
  }

  function mdy(iso) { // 1/20/2024 (from the date part only, so time zones never shift the day)
    if (!iso) return "-";
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return y ? m + "/" + d + "/" + y : "-";
  }
  function timeHM(iso) {
    const d = new Date(iso + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"));
    return isNaN(d) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  function toInputDate(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  /** exactly 6 decimals, the form the backend signs for amounts ("470" -> "470.000000") */
  function fix6(v) { const [i, f = ""] = String(v).split("."); return i + "." + (f + "000000").slice(0, 6); }
  function countdown(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return "0D 0H 0M";
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return `${d}D ${h}H ${m}M`;
  }
  const todayPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  function header(active) {
    const el = document.getElementById("app-header");
    if (!el) return;
    el.innerHTML =
      '<a class="app-logo" href="../index.html" aria-label="Back to the Tetscrow website"><span class="logo-mark" data-tetscrow3d><svg viewBox="0 0 32 32" aria-hidden="true"><polygon points="16,2 2,25 19,30" fill="currentColor"/><polygon points="16,2 19,30 30,21" fill="currentColor" opacity=".55"/></svg></span><span>Tetscrow</span></a>' +
      '<nav class="app-nav" aria-label="App"><a href="create-escrow.html"' + (active === "create" ? ' class="active"' : "") + '>Create Job</a>' +
      '<a href="dashboard.html"' + (active === "dashboard" ? ' class="active"' : "") + '>Dashboard</a></nav>' +
      '<div class="hdr-wallet"><span class="pill-inline" id="net-chip" title="Network">' + esc((window.TETSCROW_CONFIG && window.TETSCROW_CONFIG.NETWORK_NAME) || "Arc Testnet") + '</span><span class="pill-inline" id="bal-chip" hidden></span><span class="pill-inline" data-wallet-pill data-pill-inline hidden></span><button class="btn-wallet" data-wallet-btn type="button">Connect Wallet</button></div>';
    el.className = "app-top";
    Tetscrow.paintWallet();
    paintBalance();
  }

  async function paintBalance() {
    const chip = document.getElementById("bal-chip");
    if (!chip) return;
    if (!Tetscrow.getAddress()) { chip.hidden = true; return; }
    try { chip.textContent = fmt(await Tetscrow.usdcBalance()) + " USDC"; chip.hidden = false; } catch { chip.hidden = true; }
  }
  window.addEventListener("tetscrow:wallet", paintBalance);

  function gate(host, withButtonText) {
    host.innerHTML = '<div class="gate"><div class="hawk-slot" data-scene="computer" data-img="../assets/hawk-computer.png" aria-label="Hawk at a computer terminal"></div>' +
      '<p>Authorization required, please connect wallet to begin.</p><button class="btn-white" type="button" data-wallet-btn>' + (withButtonText || "Connect Wallet") + '</button></div>';
    if (window.Hawk3D) window.Hawk3D.scan(host);
    Tetscrow.paintWallet();
  }

  const signedIn = () => !!Tetscrow.getAddress() && !!localStorage.getItem("tetscrow_jwt") && Tetscrow.hasValidSession();

  function toast(msg, kind) {
    let box = document.getElementById("app-toast");
    if (!box) { box = document.createElement("div"); box.id = "app-toast"; box.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:300;display:flex;flex-direction:column;gap:8px;align-items:center;max-width:92vw"; document.body.appendChild(box); }
    const t = document.createElement("div");
    t.style.cssText = "background:" + (kind === "err" ? "#c62828" : "#000") + ";color:#fff;padding:.8em 1.3em;border-radius:14px;font-size:.92rem;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow-wrap:anywhere";
    t.textContent = msg; box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function copyBtn(addr) {
    return `<button type="button" data-copy="${esc(addr)}" aria-label="Copy address" title="Copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button>`;
  }
  const addrChip = (addr) => `<span class="chip" title="${esc(addr)}">${esc(short(addr))}${copyBtn(addr)}</span>`;
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Address copied"));
  });

  /**
   * Modal. opts: { html, steps:[labels]|null, step:n (1-based active count), narrow }
   * returns { el, close, $: (sel) => element, steps(n) }
   */
  function modal(opts) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const steps = opts.steps || null;
    const stepsHtml = steps
      ? '<div class="steps-card"><h4>Steps<span class="bars">' + steps.map((_, i) => '<i class="' + (i < (opts.step || 1) ? "on" : "") + '"></i>').join("") + '</span></h4>' +
        steps.map((s, i) => '<div class="st ' + (i < (opts.step || 1) ? "on" : "") + '"><span>&rarr;</span><span>' + esc(s) + "</span></div>").join("") + "</div>"
      : "";
    overlay.innerHTML = '<div class="modal-wrap">' + stepsHtml + '<div class="modal' + (opts.narrow ? " narrow" : "") + '" role="dialog" aria-modal="true">' + opts.html + "</div></div>";
    document.body.appendChild(overlay);
    const api = {
      el: overlay,
      close: () => overlay.remove(),
      $: (sel) => overlay.querySelector(sel),
      note: (text, kind) => { const n = overlay.querySelector(".modal-note"); if (n) { n.textContent = text; n.className = "modal-note " + (kind || ""); } },
      steps: (n) => { overlay.querySelectorAll(".steps-card .bars i").forEach((b, i) => b.classList.toggle("on", i < n)); overlay.querySelectorAll(".steps-card .st").forEach((b, i) => b.classList.toggle("on", i < n)); },
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && opts.dismissible) api.close(); });
    return api;
  }

  /** Run an async job on a button: spinner text, error toast, restores the button. */
  async function busy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { return await fn(); }
    catch (err) { toast(Tetscrow.explainError(err), "err"); throw err; }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  const readFileB64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
  const fileSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(2) + "MB" : Math.max(1, Math.round(b / 1024)) + "KB");

  async function downloadFile(jobId, msgId) {
    const f = await TetscrowApi.downloadFile(jobId, msgId);
    const bin = atob(f.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a"); a.href = url; a.download = f.file_name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const ICON = {
    chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    clock: '<svg class="ms-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg class="ms-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#000"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg class="ms-ico" viewBox="0 0 24 24" fill="none" stroke="#a52020" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>',
    file: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    down: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    ticks: '<svg width="16" height="10" viewBox="0 0 24 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8l4 4L14 2M10 10l2 2L22 2"/></svg>',
    menu: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h10M4 17h16"/></svg>',
    msg: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1.2-4.4A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>',
  };

  return { fix6, paintBalance, esc, short, fmt, DUCK, avatarImg, mdy, timeHM, toInputDate, countdown, todayPlus, header, gate, signedIn, toast, addrChip, modal, busy, readFileB64, fileSize, downloadFile, ICON };
})();
