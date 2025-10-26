// src/index.js (CommonJS)
const squirrelStartup = require('electron-squirrel-startup');
const { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const { checkForNpcap } = require('./client/npcapHandler.js');
const { setupAutoUpdate } = require('./updater.js'); // auto-update

if (squirrelStartup) app.quit();

let SERVER_URL = null;
let MAIN_WINDOW_ID = null;

/* --------------- IPC (enregistrés globalement) --------------- */
function safeHandle(channel, handler) {
    try { ipcMain.removeHandler(channel); } catch { /* no-op */ }
    ipcMain.handle(channel, handler);
}

// Copie un dataURL d'image
safeHandle('copy-image-dataurl', async (_evt, dataURL) => {
    try {
        const img = nativeImage.createFromDataURL(String(dataURL || ''));
        if (!img || img.isEmpty()) throw new Error('invalid image');
        clipboard.writeImage(img);
        return true;
    } catch (e) {
        console.error('[IPC] copy-image-dataurl failed:', e);
        return false;
    }
});

// Capture rect → dataURL
safeHandle('capture-rect', async (evt, bounds) => {
    try {
        const win = BrowserWindow.fromWebContents(evt.sender);
        if (!win) throw new Error('no window');
        const img = await win.capturePage({
            x: Math.max(0, Math.floor(bounds?.x ?? 0)),
            y: Math.max(0, Math.floor(bounds?.y ?? 0)),
            width: Math.max(1, Math.floor(bounds?.width ?? 1)),
            height: Math.max(1, Math.floor(bounds?.height ?? 1)),
        });
        return img && !img.isEmpty() ? img.toDataURL() : null;
    } catch (e) {
        console.error('[IPC] capture-rect failed:', e);
        return null;
    }
});

// Capture rect → presse-papiers
safeHandle('sessions-capture-to-clipboard', async (evt, bounds) => {
    try {
        const win = BrowserWindow.fromWebContents(evt.sender);
        if (!win) throw new Error('no window');
        const img = await win.capturePage({
            x: Math.max(0, Math.floor(bounds?.x ?? 0)),
            y: Math.max(0, Math.floor(bounds?.y ?? 0)),
            width: Math.max(1, Math.floor(bounds?.width ?? 1)),
            height: Math.max(1, Math.floor(bounds?.height ?? 1)),
        });
        if (!img || img.isEmpty()) return false;
        clipboard.writeImage(img);
        return true;
    } catch (e) {
        console.error('[IPC] sessions-capture-to-clipboard failed:', e);
        return false;
    }
});

// Focus main/child
safeHandle('focus-main-window', async () => {
    const win = MAIN_WINDOW_ID ? BrowserWindow.fromId(MAIN_WINDOW_ID) : null;
    if (win) { win.show(); win.focus(); return true; }
    return false;
});
safeHandle('focus-child-window', async () => {
    const wins = BrowserWindow.getAllWindows();
    const child = wins.find((w) => w.id !== MAIN_WINDOW_ID);
    if (child) { child.show(); child.focus(); return true; }
    return false;
});

/* -------------------- Bootstrap -------------------- */
async function initialize() {
    const canProceed = await checkForNpcap();
    if (!canProceed) return;

    const windowMod = require('./client/Window.js');
    const window = windowMod.default || windowMod;

    const shortcuts = require('./client/shortcuts.js');
    const registerShortcuts = shortcuts.registerShortcuts;

    // server.js est ESM → import dynamique
    const { default: server } = await import('./server.js');

    // Listeners IPC renderer
    require('./client/IpcListeners.js');

    if (process.platform === 'win32') app.setAppUserModelId(app.name);

    const mainWin = window.create();
    MAIN_WINDOW_ID = (mainWin && mainWin.id) || null;
    if (registerShortcuts) registerShortcuts();

    // -------- chemins runtime (DEV vs .EXE) --------
    const isPackaged = app.isPackaged;
    const userDataDir = app.getPath('userData'); // dossier RW

    // ⚠️ index.js est dans /src → en prod, tout est dans .../resources/app.asar/src/...
    const baseDir = isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'src')
        : __dirname;

    const paths = {
        publicDir: path.join(baseDir, 'public'),
        settingsPath: path.join(userDataDir, 'settings.json'),
        logsDir: path.join(userDataDir, 'logs'),
    };

    // Auto-update
    const getMainWindow = () => (MAIN_WINDOW_ID ? BrowserWindow.fromId(MAIN_WINDOW_ID) : null);
    setupAutoUpdate({ ipcMain, getMainWindow, safeHandle });

    try {
        console.log('[Main] Starting server with paths:', paths);
        const serverUrl = await server.start(paths).catch(err => {
            console.error('[Main] server.start failed:', err);
        });

        process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

        const urlToLoad = serverUrl || 'http://localhost:8990'; // fallback sûr
        SERVER_URL = urlToLoad;

        console.log(`[Main] Server started. Loading URL: ${urlToLoad}`);
        window.loadURL(urlToLoad);
    } catch (error) {
        console.error('[Main] CRITICAL: Failed to start server:', error);
        app.quit();
    }
}

app.on('ready', () => { initialize().catch((err) => console.error('[Main] init error:', err)); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) initialize().catch(console.error); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
