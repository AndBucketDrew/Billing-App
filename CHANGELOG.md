# Changelog

All notable changes to this project will be documented in this file.

---

## [1.2.0] — 2026-06-07

### Added

* **Rescan button** — new header action clears all pending/rejected items and re-scans the last 30 days; saved items are preserved so the filing history is not lost
* **TNEF / winmail.dat extraction** — Outlook Rich-Text-Format emails that wrap attachments inside a `winmail.dat` blob are now properly handled end-to-end
  * The poller downloads and unpacks the TNEF container before handing filenames to the detector, so the real PDF name (e.g. `invoice_2026000056.pdf`) is shown in the UI instead of `winmail.dat`
  * Saving a TNEF-sourced invoice extracts the actual file from the blob — the user receives the real PDF, not the raw container
  * RTF body-only winmail.dat (no embedded file) is extracted as an `.rtf` named after the email subject
  * Added `@kenjiuno/decompressrtf` dependency for RTF decompression
* **Duplicate-save protection** — a `savedIds` set is now persisted alongside `lastChecked` in the poll-state file; high-confidence invoices are never auto-saved twice even after a timestamp reset or crash
* **No-attachment fallback scoring** — when the server confirms `hasAttachments: true` but the attachment fetch fails, the message is scored on subject/sender/body alone and surfaced as medium confidence with a "confirm manually" note
* **Forwarded-email bonus** — emails with `Fwd:`, `WG:`, `Wg:`, `Weitergeleitet:`, `TR:`, `VL:` subject prefixes receive +20 pts, so a forwarded PDF with no other signals clears the medium threshold
* **International brand matching** — commercial-sender bonus now fires for any TLD variant (e.g. `paypal.at`, `amazon.de`) via a brand-name set, without requiring every country TLD to be listed explicitly
* **DOCX / DOC support** — Word documents are now accepted by the detector and saved correctly alongside PDFs
* **Invoice counter year reset** — the invoice counter automatically resets to 1 at the start of each new year; a startup migration anchors the year field for existing installs so the reset triggers correctly

### Changed

* **Fetch Now is now fire-and-forget** — the IPC call returns immediately; detected invoices arrive via the existing `invoicesDetected` push event and the spinner stays up until `pollComplete` or `pollError` fires (120 s safety timeout). This prevents the renderer from blocking on large mailboxes
* **Messages per poll raised from 50 → 1000** — avoids silently missing emails on busy accounts
* **First-run lookback extended from 24 h → 30 days** — new installs scan the last month on the very first poll
* **Body-keyword bonus split into strong/weak tiers** — unambiguous invoice terms (`rechnung`, `invoice`, `honorarnote`, …) earn +20; weaker terms (`payment`, `zahlung`, `kauf`, …) keep +5, so PDFs with an invoice keyword in the body but nothing in the subject/filename still clear the medium threshold
* **Inline attachment filter tightened** — only inline *images* (embedded logos / signatures) are skipped; PDFs and Word documents with `inline` disposition are always processed, since some mail clients mis-set this flag for real attachments
* **IMAP datetime deduplication** — `internalDate` (server delivery time) is used instead of the `Date:` header for accurate sub-day filtering; IMAP SINCE is date-granular, so messages delivered earlier the same day are now correctly skipped
* **`mergeInvoices` refactored** — uses a `Set` for O(1) duplicate lookup and sorts incoming invoices by received date descending before prepending to the list; array spread ensures mat-table detects the change
* **Attachment fetch failure emits a warning** — if a message's attachments cannot be retrieved, a non-fatal `outlook:warning` push event is sent to the renderer so the user can investigate manually
* **`subject` passed to `saveAttachment`** — used as filename fallback when TNEF extraction yields an RTF body with no embedded filename

### Fixed

* **Path traversal after TNEF extraction** — extracted filenames are re-validated against the inbox root after sanitisation; an embedded filename containing `..` segments can no longer escape the configured folder
* **Auto-save used raw `winmail.dat` filename** — the auto-saver now resolves the real attachment name from the TNEF blob before writing to disk, matching the behaviour of the manual save path
* **`isPolling` UI state after `fetchNow`** — the spinner is now controlled by `pollComplete` / `pollError` events rather than the `fetchEmails` return value, so it reflects actual poll completion even on slow connections
* **Mat-table row updates not rendering** — `autoSaved` and `autoSaveError` handlers now replace the array reference with a spread copy so Angular's OnPush change detection picks up the updated row

---

## [1.1.1]

### Added

* **Mark invoice as paid / unpaid**  finalized invoices now have a payment icon button in the actions column to toggle the paid state

### Changed

* **Action buttons for non-draft invoices**  the edit (pencil) and delete (trash) buttons are now hidden entirely for finalized and storniert invoices instead of being shown as disabled

### Fixed

* **Invoice number assigned at finalization, not on draft creation** — drafts no longer consume an invoice-counter slot. The number is generated atomically together with the `finalized` status in a single main-process write, so a failed save can never produce a gap in the numbering sequence or leave a draft with a "consumed" number that was never actually used.

* **Credit note creation is now a single atomic write** — previously, creating a Gutschrift issued two separate `writeJsonFile` calls (one to create the credit note, one to mark the original as `storniert`). A crash between the two could leave the original still showing as `finalized` while the credit note already existed a double-billing inconsistency. Both changes now land in one write.


---

## [1.1.0]

### Added

* **IMAP mailbox support** — the Outlook Invoice Inbox now works with any standard IMAP account (custom domains, shared hosting, cPanel, etc.) in addition to Microsoft 365
  * New connection-type toggle in Settings: **Microsoft 365** (Azure AD / MSAL) or **IMAP / Custom mailbox**
  * IMAP settings: server hostname, port, SSL/TLS toggle, email address, and password
  * Password is encrypted at rest using Electron `safeStorage` (Windows DPAPI / macOS Keychain / libsecret) — never stored in plaintext

### Changed

* **Internal** — `GraphClient`, `MockMailClient`, `MailPoller`, and `InvoiceDetector` now operate on a generic `IMailClient` / `MailMessage` / `MailAttachment` interface instead of Microsoft Graph-specific types, making it straightforward to add further backends
* **`mock` mode** — activate by setting IMAP host to `mock` (IMAP mode) or Client ID to `mock` (MSAL mode)

---

## [1.0.7]

### Added

* **Gutschrift (Credit Note)** — finalized invoices now have a **G** action button that creates a matching credit note
  * Credit note invoice number is the original number with a `G` suffix (e.g. `260521-1524-026G`)
  * All line item amounts are automatically negated so the credit note exactly cancels the original
  * The original invoice is immediately marked **Storniert** (voided) — edit, finalize, and delete are disabled for storniert invoices
  * A purple **Gutschrift** chip is shown in the Status column; storniert invoices show a red strikethrough badge
  * PDF output uses **Gutschrift** / **Credit Note** as the document title, adds a reference line to the original invoice, and omits the payment QR code

### Changed

* **Invoice list sort** — credit notes now always appear directly below the invoice they correct, in both the UI list and the Excel export (sort key: base number descending, then regular before G)
* **Excel export** — invoices are now sorted ascending by base number with the matching Gutschrift immediately after its parent; a new **Type** column (`Rechnung` / `Gutschrift`) is included in the export
* **Action button guards** — edit and delete buttons are now disabled for any non-draft invoice (`status !== 'draft'`), covering both `finalized` and the new `storniert` state

---

## [1.0.6]

### Fixed

* **Outlook / `outlook-ipc.ts`** — `auth.logout()` was not awaited, causing errors to be silently dropped on sign-out
* **Outlook / `msal-auth.ts`** — token refresh fallback could crash with a null/undefined access token or an empty accounts array after interactive re-login.. added proper null guards throughout
* **Outlook / `outlook-ipc.ts`** — `makeAutoSaver` closed over the mutable `graph` variable.
* **Outlook / `outlook-ipc.ts`** — `saveAttachment` did not validate `targetFolder` against the configured inbox root, allowing path traversal to arbitrary locations
* **Outlook / `invoice-detector.ts`** — commercial domain matching used `String.includes()` on the full sender address, so a spoofed address like `fakepaypal@evil.com` would match `paypal`; matching now extracts the `@domain` part and checks for exact match or subdomain only
* **Outlook / `outlook-ipc.ts`** — "Fetch Now" always re-scanned the same last 50 emails with no date filter; it now tracks `lastManualFetch` and passes it as `since` so each manual fetch only returns new emails

### Changed

* **Outlook / `invoice-detector.ts`** — `InvoiceDetector` now accepts a `locale`, so folder names respect the system locale instead of always using English
* **Outlook / `graph-client.ts`** — removed `Content-Type: application/json` header 

---

## [1.0.5]

### Added

* **Trusted Senders** — add specific email addresses to a trusted list in Outlook Settings attachments from those addresses always score 100 and are guaranteed high-confidence regardless of filename or subject
* **Auto-download high-confidence invoices** new toggle in Outlook Settings.. when enabled, attachments scoring ≥ 70 are saved automatically to the inbox folder during polling without manual confirmation, auto-saved files still appear in the table with a "saved" status
* `InvoiceDetector` now accepts the trusted-senders list and awards the full 100-point bonus when the sender email matches exactly

---

## [1.0.4]

### Fixed

* **Mail poller `lastChecked` persistence** — the poller now saves the last successful poll timestamp in the app data folder; on restart it resumes from where it left off instead of always re-scanning the previous 24 hours, eliminating the risk of missing emails on the initial scan after a restart
* **Poll error no longer advances the scan window** — if a poll fails  the `lastChecked` timestamp is rolled back so the failed time window is retried on the next interval

---

## [1.0.3]

### Added

* **Data integrity protection** for all local JSON files (`invoices.json`, `tours.json`, `settings.json`)
  * A `.bak` snapshot of the previous good state is kept alongside each data file in `%AppData%\Good Vienna TOurs\`
  * On startup, if a data file fails to parse, the app automatically falls back to the `.bak` and continues normally instead of crashing
* **`AppBannerComponent`** — reusable sticky banner component (`warning` / `error` variants) added to the shared module for future use

---

## [1.0.2]

### Added

* **Dashboard** — new default landing page (`/dashboard`) with an overview of key stats, a recent invoices list, quick-action buttons, and an Excel export shortcut with year picker

---

## [1.0.1]

### Added

* **Excel Year Export** — export all invoices for a selected year to an `.xlsx` file directly from the invoice list; year is auto-detected from the invoice number prefix (e.g. `26` → 2026)
* **Known Customer Autofill** — invoice editor now suggests previously used customer names and auto-fills address, email, and company details when a known customer is selected

---

## [1.0.0 Beta !!]

### Added

* **Outlook Invoice Inbox** — new page (`/outlook`) that connects to a Microsoft 365 mailbox via the Microsoft Graph API
* Microsoft authentication using MSAL (`@azure/msal-node`) with OAuth2 interactive login via the system browser
* Heuristic invoice detection engine with confidence scoring (0–100 pts)
* Review UI: per-attachment actions to confirm, reject, or choose a custom save folder
* Confirmed invoices are saved to a configurable local folder structure (`year/month`)
* Background mail poller with configurable interval (default 5 min), push notifications to the UI when new invoices are detected
* Secure token storage — MSAL token cache encrypted with Electron `safeStorage` (OS keychain / DPAPI); tokens never exposed to the renderer process

### Changed

* All feature component stylesheets (`invoice-list`, `tour-list`, `settings`) refactored to use the shared SCSS mixins — eliminates ~1000 lines of duplicated CSS

---

## [0.1.8]

### Added

* QR Code on Invoice

---

## [0.1.7]

### Added

* Text parser to automatically extract and add line items to the table

### Changed

* Improved invoice form fields
* Updated invoice editor
* Updated line items editor

---

## [0.1.6]

### Added

* Additional invoice form fields

---

## [0.1.5a]

### Added

* Invoice counter (e.g. 001, 002, 003, ...)
* New invoice form fields

### Changed

* Updated application settings

### Fixed

* Prevented multiple instances of the app running simultaneously

---

## [0.1.4]

### Added

* New form fields for invoices

---

## [0.1.3]

### Changed

* Cancellation calculation updated from brutto → netto (instead of netto → brutto)

### Fixed

* Fixed issue where fields in the line items table could not be focused

---

## [0.1.1]

### Added

* New model fields: `meetingPoint`, `civitatisId`
* Custom application logo

### Changed

* Updated default application styling
* Improved editing in line items table

---

## [0.1.0]

### Added

* Initial release
* Basic invoice creation functionality
