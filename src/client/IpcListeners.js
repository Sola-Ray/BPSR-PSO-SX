// src/client/IpcListeners.js  (CommonJS, minimal)
const { app, ipcMain } = require('electron');

// �ventuel event simple (pas handle) :
ipcMain.on('close-client', () => app.quit());

// IMPORTANT : ne rien enregistrer d'autre ici.
// Tous les ipcMain.handle(...) (focus-main/child, capture-rect,
// sessions-capture-to-clipboard, copy-image-dataurl, open-share-canvas)
// sont D�J� g�r�s dans src/index.js.
module.exports = {};
