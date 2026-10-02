// Shared by every public page: header, footer, link wiring, copy button, toast.
(function () {
  "use strict";
  var S = window.TETSCROW_SITE || { links: {}, press: [], email: "" };
  var C = window.TETSCROW_CONFIG || {};

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  var escrowAddr = (C.TETSCROW_ESCROW_ADDRESS || "").trim();
  var contractLive = /^0x[0-9a-fA-F]{40}$/.test(escrowAddr) && !/^0x0+$/.test(escrowAddr);
  var explorer = C.EXPLORER || "https://testnet.arcscan.app";
  var tokenUrls = {
    explorer: contractLive ? (explorer + "/address/" + escrowAddr) : "",
  };

  function makePending(a, message) {
    a.setAttribute("href", "#");
    a.classList.add("is-pending");
    a.addEventListener("click", function (e) { e.preventDefault(); toast(message); });
  }

  function wireLinks(root) {
    root = root || document;
    root.querySelectorAll("[data-link]").forEach(function (a) {
      var key = a.getAttribute("data-link");
      var url = (S.links[key] || "").trim();
      if (!url && key === "docs") url = (S.links.gitbook || "").trim();
      if (url) {
        a.setAttribute("href", url);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      } else {
        makePending(a, "This link isn't set up yet, it's coming soon.");
      }
    });
    root.querySelectorAll("[data-token-link]").forEach(function (a) {
      var key = a.getAttribute("data-token-link");
      if (contractLive && tokenUrls[key]) {
        a.setAttribute("href", tokenUrls[key]);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      } else {
        makePending(a, "The contract address will be published at launch.");
      }
    });
    root.querySelectorAll("[data-email]").forEach(function (a) {
      a.setAttribute("href", "mailto:" + S.email);
      if (a.hasAttribute("data-email-text")) a.textContent = S.email;
    });
  }

  var mark = '<svg viewBox="0 0 32 32" aria-hidden="true"><polygon points="16,2 2,25 19,30" fill="currentColor"/><polygon points="16,2 19,30 30,21" fill="currentColor" opacity=".55"/></svg>';
  var copySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

  var header = document.getElementById("site-header");
  if (header) {
    header.outerHTML =
      '<nav class="nav" id="nav"><div class="wrap">' +
        '<a class="logo" href="index.html" aria-label="Tetscrow home"><span class="logo-mark" data-tetscrow3d>' + mark + '</span><span>Tetscrow</span></a>' +
        '<div class="nav-links">' +
          '<a href="index.html#about">About</a>' +
          '<a href="index.html#products">Products</a>' +
          '<a href="index.html#how-it-works">How We Work</a>' +
          '<a href="#" data-link="docs">Docs</a>' +
        '</div>' +
        '<div class="nav-right">' +
          '<a class="btn btn-dark btn-sm" href="app/index.html">Launch App</a>' +
          '<button class="menu-btn" id="menu-btn" aria-label="Menu" aria-expanded="false">&#9776;</button>' +
        '</div>' +
      '</div></nav>';
  }

  var footer = document.getElementById("site-footer");
  if (footer) {
    footer.innerHTML =
      '<div class="wrap">' +
        '<div class="contract-row">' +
          '<strong>Contract Address</strong>' +
          '<div class="pill-field" style="flex:1 1 420px">' +
            '<span class="addr" id="contract-addr"></span>' +
            '<button class="copy-btn" id="copy-btn" aria-label="Copy contract address">' + copySvg + '</button>' +
          '</div>' +
          '<strong>Email</strong>' +
          '<a class="pill-field" data-email data-email-text></a>' +
        '</div>' +
        '<div class="footer-cols">' +
          '<div><a class="logo" href="index.html">' + mark + '<span>Tetscrow</span></a></div>' +
          '<div><h4>Docs</h4><a href="#" data-link="pitchDeck">Pitch Deck</a><a href="#" data-link="gitbook">Gitbook</a></div>' +
          '<div><h4>Follow Us</h4><a href="#" data-link="twitter">Twitter</a><a href="#" data-link="telegram">Telegram</a><a href="#" data-link="youtube">YouTube</a></div>' +
          '<div><h4>Why Tetscrow?</h4><p>Milestone-based USDC escrow on Arc — secure, transparent, and instant. Network fees are paid in USDC too. Your funds, your rules.</p></div>' +
        '</div>' +
        '<p class="fine">Tetscrow is non-custodial software and nothing on this site is financial advice. The escrow smart contract is unaudited and you should always verify contract addresses yourself before interacting with them. Testnet USDC has no real value.</p>' +
      '</div>';

    var addrEl = document.getElementById("contract-addr");
    var copyBtn = document.getElementById("copy-btn");
    if (contractLive) {
      addrEl.textContent = escrowAddr;
    } else {
      addrEl.textContent = "Contract address will be published at launch";
      copyBtn.style.opacity = ".35";
      copyBtn.style.cursor = "not-allowed";
    }
    copyBtn.addEventListener("click", async function () {
      if (!contractLive) { toast("The contract isn't deployed yet — check back at launch."); return; }
      var ok = await copyText(escrowAddr);
      toast(ok ? "Contract address copied" : "Copy failed, please select and copy it manually");
      if (ok) {
        copyBtn.classList.add("done");
        setTimeout(function () { copyBtn.classList.remove("done"); }, 1800);
      }
    });
  }

  var nav = document.getElementById("nav");
  var menuBtn = document.getElementById("menu-btn");
  if (nav && menuBtn) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll(".nav-links a").forEach(function (a) {
      a.addEventListener("click", function () { nav.classList.remove("open"); });
    });
  }

  if (window.Hawk3D) { window.Hawk3D.scan(document); }

  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest('a[href="app/index.html"]') : null;
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) { return; }
    e.preventDefault();
    var r = a.getBoundingClientRect();
    var ox = ((r.left + r.width / 2) / window.innerWidth * 100).toFixed(1);
    var oy = ((r.top + r.height / 2) / window.innerHeight * 100).toFixed(1);
    try { sessionStorage.setItem("tetscrow_launch_origin", ox + "% " + oy + "%"); } catch (e2) { /* private-mode storage block: app page falls back to its default corner */ }
    var o = document.createElement("div");
    o.className = "wipe";
    o.style.setProperty("--ox", ox + "%");
    o.style.setProperty("--oy", oy + "%");
    document.body.appendChild(o);
    requestAnimationFrame(function () { requestAnimationFrame(function () { o.classList.add("go"); }); });
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(function () { window.location.href = "app/index.html"; }, reduce ? 0 : 560);
  });

  wireLinks(document);
  window.TetscrowSite = { toast: toast, wireLinks: wireLinks, esc: esc, copyText: copyText };
})();
