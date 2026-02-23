import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

import type {
  Tour,
  Invoice,
  CompanySettings,
  ToursData,
  InvoicesData
} from '../src/app/core/models/domain.models';

const USER_DATA_PATH = app.getPath('userData');
const TOURS_FILE    = path.join(USER_DATA_PATH, 'tours.json');
const INVOICES_FILE = path.join(USER_DATA_PATH, 'invoices.json');
const SETTINGS_FILE = path.join(USER_DATA_PATH, 'settings.json');

let mainWindow: BrowserWindow | null = null;


// ============================================
// FILE SYSTEM HELPERS
// ============================================

function ensureDataFiles(): void {
  if (!fs.existsSync(USER_DATA_PATH)) {
    fs.mkdirSync(USER_DATA_PATH, { recursive: true });
  }

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

function readJsonFile<T>(filePath: string): T {
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

function writeJsonFile<T>(filePath: string, data: T): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================
// WINDOW MANAGEMENT
// ============================================

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
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
  invoice: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Invoice> => {
  const data = readJsonFile<InvoicesData>(INVOICES_FILE);

  const newInvoice: Invoice = {
    ...invoice,
    id: uuidv4(),
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
// APP LIFECYCLE
// ============================================

app.whenReady().then(() => {
  ensureDataFiles();
  createWindow();

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