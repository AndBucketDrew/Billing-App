"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Expose protected methods that can be called from the renderer
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    tour: {
        getAll: () => electron_1.ipcRenderer.invoke('tour:getAll'),
        create: (tour) => electron_1.ipcRenderer.invoke('tour:create', tour),
        update: (id, updates) => electron_1.ipcRenderer.invoke('tour:update', id, updates),
        delete: (id) => electron_1.ipcRenderer.invoke('tour:delete', id)
    },
    invoice: {
        getAll: () => electron_1.ipcRenderer.invoke('invoice:getAll'),
        getById: (id) => electron_1.ipcRenderer.invoke('invoice:getById', id),
        create: (invoice) => electron_1.ipcRenderer.invoke('invoice:create', invoice),
        update: (id, updates) => electron_1.ipcRenderer.invoke('invoice:update', id, updates),
        delete: (id) => electron_1.ipcRenderer.invoke('invoice:delete', id)
    },
    settings: {
        get: () => electron_1.ipcRenderer.invoke('settings:get'),
        update: (updates) => electron_1.ipcRenderer.invoke('settings:update', updates),
        selectLogo: () => electron_1.ipcRenderer.invoke('settings:selectLogo')
    },
    pdf: {
        save: (pdfBase64, filename) => electron_1.ipcRenderer.invoke('pdf:save', pdfBase64, filename)
    }
});
//# sourceMappingURL=preload.js.map