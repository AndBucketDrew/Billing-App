# Good Vienna Tours - Billing App

A desktop billing and invoice management application. Packaged as a cross-platform Electron app with an Angular frontend.

For a full list of changes see [CHANGELOG.md](CHANGELOG.md).

---

## Stack

**Frontend:** Angular 19.2 (non-standalone components, lazy-loaded feature modules), Angular Material, RxJS
**Desktop runtime:** Electron 29 with context isolation and a typed IPC preload bridge

---

## Architecture

The app follows a strict main/renderer separation. The Angular renderer never touches Node APIs directly everything goes through a typed `ElectronAPI` exposed via the preload script.

**Main process modules (`electron/`):**
- `main.ts` — IPC handler registration, JSON file persistence, single-instance lock
- `auth/msal-auth.ts` — MSAL Node OAuth2 flow; tokens encrypted at rest via `electron.safeStorage`
- `graph/graph-client.ts` — Minimal Microsoft Graph REST wrapper
- `graph/mail-poller.ts` — Interval-based background polling; emits push IPC events to renderer
- `ipc/outlook-ipc.ts` — Outlook IPC channel registration

**Angular feature modules (`src/app/features/`):**
- `invoice-list` / `invoice-editor` — Reactive form-driven invoice CRUD
- `tours` — Tour catalog management
- `settings` — Company profile, logo, bank details, Outlook config
- `outlook-inbox` — Inbox monitoring UI; displays detected invoices with confidence scores
- `dashboard` — Overview monitoring UI; displays recent invoices list, quick-action buttons

**Core services (`src/app/core/services/`):**
- `ElectronService` — IPC bridge with a browser mock for `ng serve` development used on 'mock-data-demo' branch
- `CalculationService` — Pure VAT breakdown and line-item totals
- `PdfGeneratorService` — Client-side PDF assembly via pdfmake (logos, QR codes, multi-language labels)
- `ExcelExportService` — Year-based XLSX workbook generation via the `xlsx` library
- `OutlookService` — RxJS Observable wrapper over Outlook IPC
---

## Data Persistence

No database. All state lives in JSON files written to Electron's `userData` directory:

- `tours.json`
- `invoices.json`
- `settings.json`
- `.outlook_cache.enc` — AES-encrypted OAuth tokens via `electron.safeStorage`


---

## Microsoft Graph / Outlook Integration

Authentication uses `@azure/msal-node` with a multi-tenant Azure AD app registration. The OAuth2 flow opens the system browser for interactive login... subsequent requests use silent token refresh with OS-keychain-backed token storage. Scopes: `Mail.Read`, `offline_access`.

The `MailPoller` runs on a configurable interval (default 5 min) in the main process. For each poll cycle it fetches messages with attachments since the last checkpoint, runs them through the `InvoiceDetector` scoring engine, and pushes an `outlook:invoicesDetected` IPC event to the renderer.

**InvoiceDetector** is a pure heuristic scoring engine. Each attachment is scored 0-100 across signals: filename keywords, email subject, body text, sender domain, and file extension. Scores map to three confidence levels (`high >= 70`, `medium 35-69`, `low < 35`). High-confidence hits are auto-suggested; medium requires user confirmation. Multilingual keyword sets cover German (`Rechnung`), English, Spanish, and Italian.

---

## Document Generation

**PDF** — pdfmake 0.2.10, fully client-side. Supports company logo (base64), QR code (via `qrcode` 1.5), multi-language headers and footers, VAT breakdown table, and bank wire details. File save uses the native Electron `showSaveDialog`.

**Excel** — `xlsx` 0.18.5. Generates a single workbook with one sheet per export filtered by year. Columns include invoice number, dates, customer, payment method, pax, guide, and all financial totals.

---

## Internationalisation

`@ngx-translate/core` 15 with an HTTP JSON loader. Translation files at `src/assets/i18n/de.json` (default) and `en.json`. Language can be switched at runtime; invoices carry their own `language` field so PDF output matches the customer's locale independently of the UI language.

---

## Build & Run

```bash
# Development (ng serve + Electron watch concurrently)
npm run electron:dev

# Browser-only dev (uses IPC mock)
npm run start

# Production build
npm run build:prod

# Package for distribution
npm run package:win
npm run package:mac
npm run package:linux
```


---


- **No backend server.** The Electron main process is the backend. This simplifies deployment to a single installable binary with no infra dependencies.
- **Token security.** OAuth tokens never leave the main process and are encrypted with the OS keychain via `electron.safeStorage` before being written to disk.
