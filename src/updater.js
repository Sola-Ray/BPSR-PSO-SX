// src/updater.js (CJS)
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

/**
 * Initialise l’auto-update et expose 2 IPC:
 *  - update:check     -> lance la recherche de MAJ
 *  - update:install   -> installe la MAJ déjà téléchargée (redémarre)
 *
 * Événements émis vers le renderer:
 *  - update:checking
 *  - update:available {version, releaseDate}
 *  - update:none
 *  - update:progress  {percent, transferred, total, bytesPerSecond}
 *  - update:downloaded {version, releaseDate}
 *  - update:error     {message}
 */
function setupAutoUpdate({ ipcMain, getMainWindow, safeHandle }) {
    // Comportements recommandés
    autoUpdater.autoDownload = true;          // télécharge dès qu’une MAJ est trouvée
    autoUpdater.autoInstallOnAppQuit = true;  // installe à la fermeture si dispo

    const send = (ch, payload) => {
        const win = getMainWindow?.();
        if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
    };

    // Événements
    autoUpdater.on('checking-for-update', () => send('update:checking'));
    autoUpdater.on('update-available', (info) => {
        send('update:available', { version: info?.version, releaseDate: info?.releaseDate });
    });
    autoUpdater.on('update-not-available', () => send('update:none'));
    autoUpdater.on('download-progress', (p) => {
        send('update:progress', {
            percent: p?.percent,
            transferred: p?.transferred,
            total: p?.total,
            bytesPerSecond: p?.bytesPerSecond,
        });
    });
    autoUpdater.on('update-downloaded', (info) => {
        send('update:downloaded', { version: info?.version, releaseDate: info?.releaseDate });
    });
    autoUpdater.on('error', (err) => {
        send('update:error', { message: err?.message || String(err) });
    });

    // IPC (utilise ton utilitaire safeHandle)
    safeHandle('update:check', async () => {
        if (!app.isPackaged) {
            // En dev, évite les erreurs dues à l’absence de provider/publish
            return { ok: false, reason: 'not-packaged' };
        }
        try {
            const res = await autoUpdater.checkForUpdates();
            // res?.updateInfo contient la version distante; le flux d’événements prendra le relais
            return { ok: true, updateInfo: res?.updateInfo };
        } catch (e) {
            return { ok: false, reason: String(e) };
        }
    });

    safeHandle('update:install', async () => {
        try {
            // Installe *immédiatement* si l’update est téléchargée
            autoUpdater.quitAndInstall();
            return true;
        } catch (e) {
            send('update:error', { message: String(e) });
            return false;
        }
    });

    // Vérification auto au démarrage (packagé uniquement)
    if (app.isPackaged) {
        setTimeout(() => {
            autoUpdater.checkForUpdatesAndNotify().catch(() => { });
        }, 3000);
    }
}

module.exports = { setupAutoUpdate };
