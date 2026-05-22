/**
 * Outlook / invoice-detection types for the Angular UI.
 *
 * A1 FIX: this file is now a thin re-export barrel — types are imported directly
 * from their canonical Electron-layer sources instead of being duplicated here.
 * There is no more manual synchronisation required; a type change in the
 * Electron layer is reflected here automatically at compile time.
 *
 * Angular can resolve these paths because the tsconfig includes the project root,
 * and `import type` / `export type` are erased at compile time — no Electron
 * runtime code ever reaches the Angular bundle.
 */

// ── Invoice detector types ────────────────────────────────────────────────────
export type { ConfidenceLevel, DetectedInvoice } from '../../../../electron/invoice-detector/invoice-detector';

// ── IPC layer types (includes InvoiceReviewItem / InvoiceReviewStatus) ────────
export type {
  ConnectionType,
  OutlookSettings,
  InvoiceReviewStatus,
  InvoiceReviewItem,
} from '../../../../electron/ipc/outlook-ipc';

// ── Preload bridge types ───────────────────────────────────────────────────────
export type { OutlookAccount } from '../../../../electron/preload';
