# PingPay

A tiny, install-to-home-screen web app for **reminding people to pay you back**. Enter an
amount and your IBAN, then send a payment prompt through your phone's share sheet — either as a
**George deep link** (Erste/Sparkasse Austria) or as a **scannable EPC QR code** that works with any
European banking app.

No backend, no build step, no dependencies — just static files you can host on **GitHub Pages**.

## Features

- **George link** — builds `…/new-transfer?IBAN=…&AM=…&CC=EUR`; the recipient taps it and George
  opens with the amount and IBAN prefilled.
- **Other (QR)** — generates a standard **EPC QR code** ("Girocode") as an image you can share or save.
- **Auto BIC** — the BIC is auto-detected from the Austrian IBAN (editable; manual entry for
  unknown banks).
- **Favorites** — save accounts (name + IBAN + BIC) for one-tap reuse.
- **Onboarding tour** — a first-run guide that also explains how to add PingPay to your home screen.
- **PWA** — installable on iOS & Android, works offline.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(A local server is needed — the service worker and share APIs don't run from `file://`.)

## Deploy to GitHub Pages

A workflow at `.github/workflows/pages.yml` publishes the site automatically. To enable it once:

1. Push this branch to GitHub.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The next push (or a manual **Run workflow**) deploys the site; the URL appears in the Actions run
   and under Settings → Pages.

Because everything is static and served from the repo root, you can alternatively set **Source:
Deploy from a branch** and point it at this branch's root.

## How the formats work

**George link**

```
https://www.sparkasse.at/r/erstebank/privatkunden#/new-transfer?IBAN=<IBAN>&AM=<amount>&CC=EUR
```

**EPC QR payload** (UTF-8, line-separated)

```
BCD
001
1
SCT
<BIC>
<Recipient name>
<IBAN>
EUR<amount>

<note>
```

## Tech notes

- `vendor/qrcode.js` is a compact, dependency-free port of Project Nayuki's public-domain QR Code
  generator.
- Sharing an image via the share sheet uses the Web Share API (Level 2). On browsers without it,
  PingPay falls back to a Download button / copy-to-clipboard.
- IBAN→BIC auto-detection covers common Austrian banks; the BIC field is always editable.
