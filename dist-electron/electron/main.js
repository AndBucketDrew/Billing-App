"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const uuid_1 = require("uuid");
const USER_DATA_PATH = electron_1.app.getPath('userData');
const TOURS_FILE = path.join(USER_DATA_PATH, 'tours.json');
const INVOICES_FILE = path.join(USER_DATA_PATH, 'invoices.json');
const SETTINGS_FILE = path.join(USER_DATA_PATH, 'settings.json');
let mainWindow = null;
// ============================================
// FILE SYSTEM HELPERS
// ============================================
function ensureDataFiles() {
    if (!fs.existsSync(USER_DATA_PATH)) {
        fs.mkdirSync(USER_DATA_PATH, { recursive: true });
    }
    if (!fs.existsSync(TOURS_FILE)) {
        const initialData = { tours: [] };
        fs.writeFileSync(TOURS_FILE, JSON.stringify(initialData, null, 2));
    }
    if (!fs.existsSync(INVOICES_FILE)) {
        const initialData = { invoices: [] };
        fs.writeFileSync(INVOICES_FILE, JSON.stringify(initialData, null, 2));
    }
    if (!fs.existsSync(SETTINGS_FILE)) {
        const initialSettings = {
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
function readJsonFile(filePath) {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
}
function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
// ============================================
// WINDOW MANAGEMENT
// ============================================
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
    }
    else {
        const indexPath = path.join(electron_1.app.getAppPath(), 'dist/billing-app/browser/index.html');
        mainWindow.loadFile(indexPath);
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
// ============================================
// IPC HANDLERS - TOURS
// ============================================
electron_1.ipcMain.handle('tour:getAll', async () => {
    const data = readJsonFile(TOURS_FILE);
    return data.tours;
});
electron_1.ipcMain.handle('tour:create', async (_, tour) => {
    const data = readJsonFile(TOURS_FILE);
    const newTour = {
        ...tour,
        id: (0, uuid_1.v4)(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.tours.push(newTour);
    writeJsonFile(TOURS_FILE, data);
    return newTour;
});
electron_1.ipcMain.handle('tour:update', async (_, id, updates) => {
    const data = readJsonFile(TOURS_FILE);
    const index = data.tours.findIndex(t => t.id === id);
    if (index === -1)
        return null;
    data.tours[index] = {
        ...data.tours[index],
        ...updates,
        id,
        updatedAt: new Date().toISOString()
    };
    writeJsonFile(TOURS_FILE, data);
    return data.tours[index];
});
electron_1.ipcMain.handle('tour:delete', async (_, id) => {
    const data = readJsonFile(TOURS_FILE);
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
electron_1.ipcMain.handle('invoice:getAll', async () => {
    const data = readJsonFile(INVOICES_FILE);
    return data.invoices;
});
electron_1.ipcMain.handle('invoice:getById', async (_, id) => {
    const data = readJsonFile(INVOICES_FILE);
    return data.invoices.find(inv => inv.id === id) || null;
});
electron_1.ipcMain.handle('invoice:create', async (_, invoice) => {
    const data = readJsonFile(INVOICES_FILE);
    const newInvoice = {
        ...invoice,
        id: (0, uuid_1.v4)(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.invoices.push(newInvoice);
    writeJsonFile(INVOICES_FILE, data);
    return newInvoice;
});
electron_1.ipcMain.handle('invoice:update', async (_, id, updates) => {
    const data = readJsonFile(INVOICES_FILE);
    const index = data.invoices.findIndex(inv => inv.id === id);
    if (index === -1)
        return null;
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
electron_1.ipcMain.handle('invoice:delete', async (_, id) => {
    const data = readJsonFile(INVOICES_FILE);
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
electron_1.ipcMain.handle('settings:get', async () => {
    return readJsonFile(SETTINGS_FILE);
});
electron_1.ipcMain.handle('settings:update', async (_, updates) => {
    const current = readJsonFile(SETTINGS_FILE);
    const updated = { ...current, ...updates };
    writeJsonFile(SETTINGS_FILE, updated);
    return updated;
});
electron_1.ipcMain.handle('settings:selectLogo', async () => {
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg'] }]
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    return result.filePaths[0];
});
// ============================================
// IPC HANDLERS - PDF
// ============================================
electron_1.ipcMain.handle('pdf:save', async (_, pdfBase64, filename) => {
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        defaultPath: filename,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath)
        return null;
    const buffer = Buffer.from(pdfBase64, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return result.filePath;
});
// ============================================
// APP LIFECYCLE
// ============================================
electron_1.app.whenReady().then(() => {
    ensureDataFiles();
    createWindow();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
//# sourceMappingURL=main.js.map