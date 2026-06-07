import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { registerOutlookIpcHandlers } from './ipc/outlook-ipc';

import type {
  Tour,
  Invoice,
  CompanySettings,
  ToursData,
  InvoicesData
} from '../src/app/core/models/domain.models';

const USER_DATA_PATH = app.getPath('userData');
const TOURS_FILE = path.join(USER_DATA_PATH, 'tours.json');
const INVOICES_FILE = path.join(USER_DATA_PATH, 'invoices.json');
const SETTINGS_FILE = path.join(USER_DATA_PATH, 'settings.json');

let mainWindow: BrowserWindow | null = null;

// ============================================
// SINGLE INSTANCE LOCK
// ============================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance — focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}


// ============================================
// FILE SYSTEM HELPERS
// ============================================

function ensureDataFiles(): void {
  if (!fs.existsSync(USER_DATA_PATH)) {
    fs.mkdirSync(USER_DATA_PATH, { recursive: true });
  }

  // Recover any saves that were interrupted between .tmp write and final rename
  recoverOrphanedTmp(INVOICES_FILE);
  recoverOrphanedTmp(TOURS_FILE);
  recoverOrphanedTmp(SETTINGS_FILE);

  if (!fs.existsSync(TOURS_FILE)) {
    const initialData: ToursData = { tours: [] };
    fs.writeFileSync(TOURS_FILE, JSON.stringify(initialData, null, 2));
  }

  if (!fs.existsSync(INVOICES_FILE)) {
    const initialData: InvoicesData = { invoices: [] };
    fs.writeFileSync(INVOICES_FILE, JSON.stringify(initialData, null, 2));
  }

  if (!fs.existsSync(SETTINGS_FILE)) {
    const initialSettings: CompanySettings = {
      language: 'de',
      invoiceCounter: 1,
      companyName: '',
      companyAddress: '',
      cityCountry: '',
      vatNumber: '',
      logoPath: '',
      defaultVatPercentage: 13,
      bankName: '',
      accountHolder: '',
      iban: '',
      bic: '',
      legalForm: '',
      headquarters: '',
      courtRegistry: '',
      registrationNumber: '',
      invoiceFooterText: ''
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(initialSettings, null, 2));
  }
}

// ============================================
// INVOICE NUMBER GENERATION
// ============================================

// Pure helper — builds the invoice number string from the current wall-clock time
// and the given counter value.  Format: YYMMDD-HHmm-NNN  (e.g. 260601-1423-007)
function buildInvoiceNumber(counter: number): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = pad(now.getMonth() + 1);
  const dd  = pad(now.getDate());
  const hh  = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `${yy}${mm}${dd}-${hh}${min}-${pad(counter, 3)}`;
}

// ============================================
// ORPHAN .TMP RECOVERY
// ============================================

// If a previous run died between writing .tmp and the final rename, the .tmp
// holds data we meant to commit.  Finish the rename on the next startup so that
// save is not silently lost.
function recoverOrphanedTmp(filePath: string): void {
  const tmpPath = filePath + '.tmp';
  if (fs.existsSync(tmpPath)) {
    console.warn(`[data] Orphaned .tmp found for ${path.basename(filePath)} — finishing rename`);
    try {
      fs.renameSync(tmpPath, filePath);
      console.warn(`[data] Recovered ${path.basename(filePath)} from orphaned .tmp`);
    } catch (err) {
      console.error(`[data] Could not recover .tmp for ${path.basename(filePath)}`, err);
    }
  }
}

// Write in three steps to protect against mid-write crashes:
//   1. Write new content to a .tmp file  — if the process dies here, the real file is untouched
//   2. Copy the current file to .bak     — preserves the last known-good state before we replace it
//   3. Rename .tmp → real file           — rename is a single OS operation, so there is no window
//                                          where the file is partially written or missing
function writeJsonFile<T>(filePath: string, data: T): void {
  const tmpPath = filePath + '.tmp';
  const bakPath = filePath + '.bak';

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bakPath);
  }

  fs.renameSync(tmpPath, filePath);
}

// Try the main file first. If it fails to parse (truncated write, manual edit gone wrong, etc.)
// fall back to the .bak snapshot so one bad save doesn't take the whole app down.
function readJsonFile<T>(filePath: string): T {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      console.warn(`[data] ${path.basename(filePath)} is corrupt — loading from .bak`, err);
      // Push a visible warning to the renderer so the user knows something happened
      mainWindow?.webContents.send('data:restoredFromBackup', path.basename(filePath));
      const backup = fs.readFileSync(bakPath, 'utf-8');
      return JSON.parse(backup);
    }
    // No backup available — surface the original error
    throw err;
  }
}

// ============================================
// WINDOW MANAGEMENT
// ============================================

function createWindow(): void {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: path.join(__dirname, '../../src/assets/icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Tour Billing Application',
    backgroundColor: '#ffffff'
  });


  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:4200');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(
      app.getAppPath(),
      'dist/billing-app/browser/index.html'
    );

    mainWindow.loadFile(indexPath);
  }

  // Toggle DevTools with F12
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================
// IPC HANDLERS - TOURS
// ============================================

ipcMain.handle('tour:getAll', async (): Promise<Tour[]> => {
  const data = readJsonFile<ToursData>(TOURS_FILE);
  return data.tours;
});

ipcMain.handle('tour:create', async (_, tour: Omit<Tour, 'id' | 'createdAt' | 'updatedAt'>): Promise<Tour> => {
  const data = readJsonFile<ToursData>(TOURS_FILE);

  const newTour: Tour = {
    ...tour,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.tours.push(newTour);
  writeJsonFile(TOURS_FILE, data);
  return newTour;
});

ipcMain.handle('tour:update', async (_, id: string, updates: Partial<Tour>): Promise<Tour | null> => {
  const data = readJsonFile<ToursData>(TOURS_FILE);

  const index = data.tours.findIndex(t => t.id === id);
  if (index === -1) return null;

  data.tours[index] = {
    ...data.tours[index],
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };

  writeJsonFile(TOURS_FILE, data);
  return data.tours[index];
});

ipcMain.handle('tour:delete', async (_, id: string): Promise<boolean> => {
  const data = readJsonFile<ToursData>(TOURS_FILE);

  const initialLength = data.tours.length;
  data.tours = data.tours.filter(t => t.id !== id);

  if (data.tours.length < initialLength) {
    writeJsonFile(TOURS_FILE, data);
    return true;
  }
  return false;
});

// ============================================
// IPC HANDLERS - INVOICES
// ============================================

ipcMain.handle('invoice:getAll', async (): Promise<Invoice[]> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);
  return data.invoices;
});

ipcMain.handle('invoice:getById', async (_, id: string): Promise<Invoice | null> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);
  return data.invoices.find(inv => inv.id === id) || null;
});

ipcMain.handle('invoice:create', async (
  _,
  invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>
): Promise<Invoice> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);

  const newInvoice: Invoice = {
    ...invoice,
    id: uuidv4(),
    invoiceNumber: null,   // assigned atomically at finalization, never on draft creation
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.invoices.push(newInvoice);
  writeJsonFile(INVOICES_FILE, data);
  return newInvoice;
});

ipcMain.handle('invoice:update', async (_, id: string, updates: Partial<Invoice>): Promise<Invoice | null> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);

  const index = data.invoices.findIndex(inv => inv.id === id);
  if (index === -1) return null;

  data.invoices[index] = {
    ...data.invoices[index],
    ...updates,
    id,
    invoiceNumber: data.invoices[index].invoiceNumber,
    updatedAt: new Date().toISOString()
  };

  writeJsonFile(INVOICES_FILE, data);
  return data.invoices[index];
});

ipcMain.handle('invoice:delete', async (_, id: string): Promise<boolean> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);

  const initialLength = data.invoices.length;
  data.invoices = data.invoices.filter(inv => inv.id !== id);

  if (data.invoices.length < initialLength) {
    writeJsonFile(INVOICES_FILE, data);
    return true;
  }
  return false;
});

// Atomic finalization — assigns an invoice number from the counter and sets status
// to 'finalized' in a single consistent operation:
//   1. Generate number from counter (in memory — nothing written yet)
//   2. Update the invoice record
//   3. Write settings.json  ← counter increment FIRST; if this fails nothing is written
//                             yet and the next finalize retries with the same counter slot
//   4. Write invoices.json  ← if this fails, the counter was bumped but no invoice carries
//                             that number yet — a gap in the sequence, not a duplicate
// Credit notes already carry a derived number (originalNumber + 'G') — they skip
// counter allocation and just flip their status to 'finalized'.
ipcMain.handle('invoice:finalize', async (_, id: string): Promise<Invoice | null> => {
  const invoiceData = readJsonFile<InvoicesData>(INVOICES_FILE);
  const index = invoiceData.invoices.findIndex(inv => inv.id === id);
  if (index === -1) return null;

  const invoice = invoiceData.invoices[index];

  if (invoice.invoiceNumber) {
    // Credit note (or already numbered) — just flip the status
    invoiceData.invoices[index] = {
      ...invoice,
      status: 'finalized',
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(INVOICES_FILE, invoiceData);
    return invoiceData.invoices[index];
  }

  // Regular draft invoice — generate number atomically with finalization
  const settings = readJsonFile<CompanySettings>(SETTINGS_FILE);
  const currentYear = new Date().getFullYear();
  const yearChanged = settings.invoiceCounterYear !== undefined && settings.invoiceCounterYear !== currentYear;
  const counter = yearChanged ? 1 : (settings.invoiceCounter ?? 1);
  const invoiceNumber = buildInvoiceNumber(counter);

  invoiceData.invoices[index] = {
    ...invoice,
    invoiceNumber,
    status: 'finalized',
    updatedAt: new Date().toISOString()
  };

  writeJsonFile(SETTINGS_FILE, { ...settings, invoiceCounter: counter + 1, invoiceCounterYear: currentYear }); // bump counter first — a failed invoice write leaves a gap, not a duplicate
  writeJsonFile(INVOICES_FILE, invoiceData);

  return invoiceData.invoices[index];
});

// Atomic credit-note creation — both the new credit note and the 'storniert' update
// on the original invoice are written in ONE writeJsonFile call, so a crash cannot
// leave the two records in an inconsistent state.
ipcMain.handle('invoice:createCreditNote', async (
  _,
  originalId: string,
  payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Invoice> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);

  const newInvoice: Invoice = {
    ...payload,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Mark the original as storniert in the same in-memory array
  const originalIdx = data.invoices.findIndex(inv => inv.id === originalId);
  if (originalIdx !== -1) {
    const originalInvoiceNumber = data.invoices[originalIdx].invoiceNumber;
    if (originalInvoiceNumber !== payload.creditNoteForInvoiceNumber) {
      throw new Error(
        `creditNoteForInvoiceNumber mismatch: payload has "${payload.creditNoteForInvoiceNumber}" but original invoice has "${originalInvoiceNumber}"`
      );
    }
    data.invoices[originalIdx] = {
      ...data.invoices[originalIdx],
      status: 'storniert',
      updatedAt: new Date().toISOString()
    };
  }

  data.invoices.push(newInvoice);

  // Single write — both changes land together or neither does
  writeJsonFile(INVOICES_FILE, data);
  return newInvoice;
});

// ============================================
// IPC HANDLERS - SETTINGS
// ============================================

ipcMain.handle('settings:get', async (): Promise<CompanySettings> => {
  return readJsonFile<CompanySettings>(SETTINGS_FILE);
});

ipcMain.handle('settings:update', async (_, updates: Partial<CompanySettings>): Promise<CompanySettings> => {
  const current = readJsonFile<CompanySettings>(SETTINGS_FILE);
  const updated = { ...current, ...updates };
  writeJsonFile(SETTINGS_FILE, updated);
  return updated;
});

ipcMain.handle('settings:selectLogo', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ============================================
// IPC HANDLERS - PDF
// ============================================

ipcMain.handle('pdf:save', async (_, pdfBase64: string, filename: string): Promise<string | null> => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: filename,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled || !result.filePath) return null;

  const buffer = Buffer.from(pdfBase64, 'base64');
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// ============================================
// IPC HANDLERS - EXCEL
// ============================================

ipcMain.handle('excel:save', async (_, excelBase64: string, filename: string): Promise<string | null> => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: filename,
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });

  if (result.canceled || !result.filePath) return null;

  const buffer = Buffer.from(excelBase64, 'base64');
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// ============================================
// APP LIFECYCLE
// ============================================

app.whenReady().then(() => {
  ensureDataFiles();

  // Migration: anchor invoiceCounterYear for installs that pre-date the field.
  // Without this, existing users would never trigger the year-rollover reset
  // because the undefined check in invoice:finalize treats absent as "same year".
  const s = readJsonFile<CompanySettings>(SETTINGS_FILE);
  if (s.invoiceCounterYear === undefined) {
    writeJsonFile(SETTINGS_FILE, { ...s, invoiceCounterYear: new Date().getFullYear() });
  }

  createWindow();

  // ── Outlook / MS Graph integration ──────────────────────────────────────
  registerOutlookIpcHandlers(
    USER_DATA_PATH,
    () => mainWindow,
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});