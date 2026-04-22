# Changelog

All notable changes to this project will be documented in this file.

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
