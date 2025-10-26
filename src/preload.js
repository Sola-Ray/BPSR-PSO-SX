// src/preload.js  (ESM)
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    closeClient: () => ipcRenderer.send('close-client'),

    onTogglePassthrough: (callback) =>
        ipcRenderer.on('passthrough-toggled', (_event, value) => callback(value)),

    focusChildWindow: (nameHint) => ipcRenderer.invoke('focus-child-window', String(nameHint || '')),
    focusMainWindow: () => ipcRenderer.invoke('focus-main-window'),

    captureToClipboard: (bounds) => ipcRenderer.invoke('sessions-capture-to-clipboard', bounds),
    captureRect: (bounds) => ipcRenderer.invoke('capture-rect', bounds),

    copyImageDataURL: (dataURL) => ipcRenderer.invoke('copy-image-dataurl', dataURL),
});
