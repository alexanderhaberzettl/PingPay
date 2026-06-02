"use strict";

/* ============================================================
 * PingPay — payment reminder PWA
 * ============================================================ */

const GEORGE_BASE = "https://www.sparkasse.at/r/erstebank/privatkunden#/new-transfer";

/* Austrian Bankleitzahl (5 digits after the check digits) -> BIC.
 * Small curated table of common banks; unknown codes fall back to manual entry.
 * The BIC field always stays editable so the user can correct it. */
const AT_BLZ_TO_BIC = {
  "20506": "SPKUAT22XXX", // Sparkasse (example)
  "20111": "GIBAATWWXXX", // Erste Bank
  "12000": "BKAUATWWXXX", // UniCredit Bank Austria
  "60000": "BAWAATWWXXX", // BAWAG P.S.K.
  "32000": "RLNWATWWXXX"  // Raiffeisen NÖ-Wien
};

/* ---------- Tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const STORE = {
  favorites: "pingpay.favorites",
  onboarded: "pingpay.onboarded"
};

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- IBAN ---------- */
function normalizeIban(raw) {
  return (raw || "").replace(/\s+/g, "").toUpperCase();
}
function groupIban(raw) {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}
function isValidIban(raw) {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(iban)) return false;
  // Move first 4 chars to the end, convert letters to numbers, mod 97 === 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of code) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}
function bicFromIban(raw) {
  const iban = normalizeIban(raw);
  if (!iban.startsWith("AT") || iban.length < 9) return "";
  const blz = iban.slice(4, 9);
  return AT_BLZ_TO_BIC[blz] || "";
}

/* ---------- Amount ---------- */
function parseAmount(raw) {
  if (!raw) return NaN;
  const n = Number(String(raw).replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
function formatAmount(n) {
  return n.toFixed(2); // dot-decimal, 2 places, e.g. "10.20"
}

/* ---------- Builders ---------- */
function buildGeorgeLink(iban, amount) {
  const params = new URLSearchParams();
  params.set("IBAN", normalizeIban(iban));
  params.set("AM", formatAmount(amount));
  params.set("CC", "EUR");
  // George reads params from the hash route; URLSearchParams encodes safely.
  return `${GEORGE_BASE}?${params.toString()}`;
}

function buildEpcPayload({ bic, name, iban, amount, note }) {
  const lines = [
    "BCD",
    "001",
    "1",
    "SCT",
    bic || "",
    (name || "").slice(0, 70),
    normalizeIban(iban),
    "EUR" + formatAmount(amount),
    "",                      // purpose (unused)
    (note || "").slice(0, 140)
  ];
  // Drop trailing empty fields (matches the EPC example when a note is present).
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/* ---------- QR rendering ---------- */
function renderQrToCanvas(text, canvas) {
  const utf8 = Array.from(new TextEncoder().encode(text));
  const qr = qrcodegen.QrCode.encodeBinary(utf8, qrcodegen.QrCode.Ecc.MEDIUM);
  const border = 4;
  const dim = qr.size + border * 2;
  const targetPx = 640;
  const scale = Math.max(2, Math.floor(targetPx / dim));
  const px = dim * scale;

  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }
}
function canvasToPngFile(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(new File([blob], filename, { type: "image/png" }));
    }, "image/png");
  });
}

/* ============================================================
 * Form state & validation
 * ============================================================ */
const els = {
  form: $("#pay-form"),
  amount: $("#amount"),
  amountErr: $("#amount-err"),
  iban: $("#iban"),
  ibanErr: $("#iban-err"),
  name: $("#name"),
  note: $("#note"),
  bic: $("#bic"),
  bicField: $("#bic-field"),
  bicHint: $("#bic-hint"),
  bankRadios: () => document.querySelectorAll('input[name="bank"]'),
  sendBtn: $("#send-btn"),
  saveFavBtn: $("#save-fav-btn"),
  result: $("#result"),
  resultGeorge: $("#result-george"),
  resultQr: $("#result-qr"),
  georgeLink: $("#george-link"),
  qrCanvas: $("#qr-canvas"),
  qrCaption: $("#qr-caption"),
  installBtn: $("#install-btn")
};

function selectedBank() {
  const checked = document.querySelector('input[name="bank"]:checked');
  return checked ? checked.value : "george";
}

function validate() {
  const amount = parseAmount(els.amount.value);
  const amountOk = Number.isFinite(amount) && amount > 0;
  els.amountErr.textContent =
    els.amount.value && !amountOk ? "Enter an amount greater than 0." : "";
  els.amount.classList.toggle("invalid", !!els.amount.value && !amountOk);

  const ibanOk = isValidIban(els.iban.value);
  els.ibanErr.textContent = els.iban.value && !ibanOk ? "This IBAN looks invalid." : "";
  els.iban.classList.toggle("invalid", !!els.iban.value && !ibanOk);

  const bank = selectedBank();
  const bicOk = bank === "george" || normalizeIban(els.bic.value).length >= 8;

  els.sendBtn.disabled = !(amountOk && ibanOk && bicOk);
  els.saveFavBtn.disabled = !ibanOk;
  return { amount, amountOk, ibanOk, bicOk, bank };
}

function syncBankUi() {
  const isOther = selectedBank() === "other";
  els.bicField.hidden = !isOther;
  if (isOther) maybeAutofillBic();
  validate();
}

function maybeAutofillBic() {
  if (!isValidIban(els.iban.value)) { els.bicHint.textContent = ""; return; }
  const auto = bicFromIban(els.iban.value);
  if (auto) {
    // Only overwrite if empty or previously auto-filled.
    if (!els.bic.value || els.bic.dataset.auto === "1") {
      els.bic.value = auto;
      els.bic.dataset.auto = "1";
    }
    els.bicHint.textContent = "(auto-detected)";
  } else {
    els.bicHint.textContent = "(couldn't auto-detect — please enter)";
  }
}

/* ============================================================
 * Send actions
 * ============================================================ */
async function shareOrFallback(shareData, fallback) {
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return true;
    } catch (err) {
      if (err && err.name === "AbortError") return true; // user cancelled
    }
  }
  fallback();
  return false;
}

function showGeorge(link) {
  els.result.hidden = false;
  els.resultGeorge.hidden = false;
  els.resultQr.hidden = true;
  els.georgeLink.textContent = link;
  els.georgeLink.href = link;
  els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showQr(payload, amount, note) {
  els.result.hidden = false;
  els.resultGeorge.hidden = true;
  els.resultQr.hidden = false;
  renderQrToCanvas(payload, els.qrCanvas);
  const caption = `€${formatAmount(amount)}` + (note ? ` · ${note}` : "");
  els.qrCaption.textContent = caption + "\nScan with your banking app to pay.";
  els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function handleSubmit(e) {
  e.preventDefault();
  const state = validate();
  if (els.sendBtn.disabled) return;

  if (state.bank === "george") {
    const link = buildGeorgeLink(els.iban.value, state.amount);
    showGeorge(link);
    shareGeorge(link, state.amount);
  } else {
    const note = els.note.value.trim();
    const payload = buildEpcPayload({
      bic: normalizeIban(els.bic.value),
      name: els.name.value.trim(),
      iban: els.iban.value,
      amount: state.amount,
      note
    });
    showQr(payload, state.amount, note);
  }
}

function shareGeorge(link, amount) {
  const text = `Please pay me back €${formatAmount(amount)} — open in George:`;
  shareOrFallback(
    { title: "PingPay reminder", text, url: link },
    () => { copyText(link, "Link copied — paste it to send."); }
  );
}

async function shareQrImage() {
  const file = await canvasToPngFile(els.qrCanvas, "pingpay-qr.png");
  const text = els.qrCaption.textContent.replace(/\n/g, " ");
  const data = { files: [file], title: "PingPay reminder", text };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const ok = await shareOrFallback(data, downloadQr);
    if (!ok) return;
  } else {
    downloadQr();
  }
}

function downloadQr() {
  els.qrCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pingpay-qr.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("QR image saved.");
  }, "image/png");
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || "Copied.");
  } catch {
    toast("Copy failed — long-press to copy.");
  }
}

/* ============================================================
 * Favorites
 * ============================================================ */
function getFavorites() { return readJSON(STORE.favorites, []); }

function renderFavorites() {
  const favs = getFavorites();
  const section = $("#favorites-section");
  const list = $("#favorites-list");
  section.hidden = favs.length === 0;
  list.innerHTML = "";
  for (const fav of favs) {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "fav-main";
    main.innerHTML =
      `<div class="fav-name"></div><div class="fav-iban"></div>`;
    main.querySelector(".fav-name").textContent = fav.label || fav.name || "Account";
    main.querySelector(".fav-iban").textContent = groupIban(fav.iban);
    main.addEventListener("click", () => applyFavorite(fav));

    const del = document.createElement("button");
    del.className = "fav-del";
    del.setAttribute("aria-label", "Delete favorite");
    del.textContent = "✕";
    del.addEventListener("click", () => deleteFavorite(fav.id));

    li.append(main, del);
    list.appendChild(li);
  }
}

function applyFavorite(fav) {
  els.iban.value = groupIban(fav.iban);
  els.name.value = fav.name || "";
  if (fav.bic) { els.bic.value = fav.bic; els.bic.dataset.auto = "0"; }
  else { els.bic.value = ""; els.bic.dataset.auto = "1"; }
  syncBankUi();
  els.amount.focus();
  toast(`Loaded ${fav.label || fav.name || "favorite"}.`);
}

function saveFavorite() {
  if (!isValidIban(els.iban.value)) return;
  const name = els.name.value.trim();
  const label = (prompt("Name this favorite:", name || "My account") || "").trim();
  if (label === "") return;
  const fav = {
    id: Date.now().toString(36),
    label,
    name,
    iban: normalizeIban(els.iban.value),
    bic: normalizeIban(els.bic.value) || bicFromIban(els.iban.value) || ""
  };
  const favs = getFavorites().filter((f) => f.iban !== fav.iban);
  favs.unshift(fav);
  writeJSON(STORE.favorites, favs);
  renderFavorites();
  toast("Favorite saved.");
}

function deleteFavorite(id) {
  writeJSON(STORE.favorites, getFavorites().filter((f) => f.id !== id));
  renderFavorites();
}

/* ============================================================
 * Onboarding tour
 * ============================================================ */
function isiOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function onboardingSteps() {
  const steps = [
    {
      title: "Welcome to PingPay",
      body: "Send anyone a quick reminder to pay you back — as a link or a scannable QR code."
    },
    {
      title: "Two ways to get paid",
      body: "Pick George to send a link that opens the George app with your amount and IBAN prefilled. Pick Other to create a QR code any European banking app can scan."
    },
    {
      title: "Fill in & share",
      body: "Enter an amount and your IBAN, add an optional note, then tap Send to share it through your phone's share sheet. Save accounts as favorites for next time."
    }
  ];
  if (!isStandalone()) {
    steps.push({
      title: "Add to Home Screen",
      body: isiOS()
        ? "In Safari, tap the Share button, then “Add to Home Screen”. PingPay then opens like a real app."
        : "Tap your browser's ⋮ menu, then “Install app” / “Add to Home screen”. PingPay then opens like a real app."
    });
  }
  return steps;
}

let obIndex = 0;
let obStepsCache = [];
function renderOnboardingStep() {
  const step = obStepsCache[obIndex];
  $("#ob-title").textContent = step.title;
  $("#ob-body").textContent = step.body;
  $("#ob-next").textContent = obIndex === obStepsCache.length - 1 ? "Get started" : "Next";
  const dots = $("#ob-dots");
  dots.innerHTML = "";
  obStepsCache.forEach((_, i) => {
    const d = document.createElement("span");
    d.className = "dot" + (i === obIndex ? " active" : "");
    dots.appendChild(d);
  });
}
function openOnboarding() {
  obStepsCache = onboardingSteps();
  obIndex = 0;
  renderOnboardingStep();
  $("#onboarding").hidden = false;
}
function closeOnboarding() {
  $("#onboarding").hidden = true;
  writeJSON(STORE.onboarded, true);
}
function nextOnboarding() {
  if (obIndex < obStepsCache.length - 1) { obIndex++; renderOnboardingStep(); }
  else closeOnboarding();
}

/* ============================================================
 * PWA install + service worker
 * ============================================================ */
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  els.installBtn.hidden = false;
});
window.addEventListener("appinstalled", () => {
  els.installBtn.hidden = true;
  deferredInstallPrompt = null;
});

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
}

/* ============================================================
 * Wire up
 * ============================================================ */
function init() {
  // Validation + reactive UI
  ["input", "change"].forEach((ev) => {
    els.amount.addEventListener(ev, validate);
    els.name.addEventListener(ev, validate);
  });
  els.iban.addEventListener("input", () => { maybeAutofillBic(); validate(); });
  els.iban.addEventListener("blur", () => {
    if (isValidIban(els.iban.value)) els.iban.value = groupIban(els.iban.value);
  });
  els.bic.addEventListener("input", () => { els.bic.dataset.auto = "0"; validate(); });
  els.bankRadios().forEach((r) => r.addEventListener("change", syncBankUi));

  els.form.addEventListener("submit", handleSubmit);
  els.saveFavBtn.addEventListener("click", saveFavorite);

  $("#share-george").addEventListener("click", () => {
    const amount = parseAmount(els.amount.value);
    shareGeorge(els.georgeLink.href, amount);
  });
  $("#copy-george").addEventListener("click", () =>
    copyText(els.georgeLink.href, "Link copied — paste it to send."));
  $("#share-qr").addEventListener("click", shareQrImage);
  $("#download-qr").addEventListener("click", downloadQr);

  // Onboarding
  $("#help-btn").addEventListener("click", openOnboarding);
  $("#ob-next").addEventListener("click", nextOnboarding);
  $("#ob-skip").addEventListener("click", closeOnboarding);

  // Install
  els.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      openOnboarding();
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.hidden = true;
  });

  renderFavorites();
  syncBankUi();
  validate();

  if (!readJSON(STORE.onboarded, false)) openOnboarding();

  registerServiceWorker();
}

document.addEventListener("DOMContentLoaded", init);
