import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const iconPath = path.join(__dirname, '../resources/app.ico');
const preloadPath = path.join(__dirname, '../preload.cjs');
const htmlPath = path.join(__dirname, '../public/index.html');
const configPath = path.join(__dirname, '../../windowConfig.json');

/**
 * A manager class to handle the application's main window,
 * including its creation, state, and configuration persistence.
 */
class Window {
    _window = null;
    config = {};
    defaultConfig = {
        width: 300,
        height: 300,
        x: undefined,
        y: undefined,
        passthrough: false,
        lastHeight: 300, // Default restore height for minimize feature
    };

    constructor() {
        this.config = this._loadConfig();
    }

    /** Loads window configuration from the JSON file. */
    _loadConfig() {
        try {
            if (fs.existsSync(configPath)) {
                const rawData = fs.readFileSync(configPath, 'utf8');
                const loadedConfig = JSON.parse(rawData);
                const config = { ...this.defaultConfig, ...loadedConfig };

                if (!this._isPositionVisible(config.x, config.y, config.width, config.height)) {
                    // Si position hors écran, recentrer
                    config.x = undefined;
                    config.y = undefined;
                }
                return config;
            }
        } catch (error) {
            console.error('Failed to read window config, using defaults.', error);
        }
        return this.defaultConfig;
    }

    /** Saves the current window state to the JSON file. */
    _saveConfig() {
        if (!this._window) return;
        try {
            const bounds = this._window.getBounds();
            const configData = {
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y,
                passthrough: this.config.passthrough,
                lastHeight: this.config.lastHeight,
            };
            fs.writeFileSync(configPath, JSON.stringify(configData, null, 4));
        } catch (error) {
            console.error('Failed to save window config.', error);
        }
    }

    /** Check if position is visible on any display. */
    _isPositionVisible(x, y, width, height) {
        const displays = screen.getAllDisplays();
        return displays.some(display => {
            const b = display.bounds;
            return (
                x >= b.x &&
                y >= b.y &&
                x + width <= b.x + b.width &&
                y + height <= b.y + b.height
            );
        });
    }

    /**
     * Creates and displays the main application window.
     * @returns {BrowserWindow} The created BrowserWindow instance.
     */
    create() {
        this._window = new BrowserWindow({
            width: this.config.width,
            height: this.config.height,
            x: this.config.x,
            y: this.config.y,
            minWidth: 400,
            minHeight: 42,
            transparent: true,
            frame: false,
            title: 'BPSR-PSO-SX',
            icon: iconPath,
            autoHideMenuBar: true, // <- option correcte
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                nativeWindowOpen: true, // <- indispensable pour que window.open crée un vrai BrowserWindow
            },
        });

        // Assigne le même preload (et mêmes flags) aux fenêtres ouvertes via window.open
        this._window.webContents.setWindowOpenHandler((_details) => {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    // parent: this._window, // (optionnel) si vous voulez les garder au premier plan de l'app
                    modal: false,
                    webPreferences: {
                        preload: preloadPath,
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: false,
                    },
                },
            };
        });

        this._window.setAlwaysOnTop(true, 'normal');
        this._window.setMovable(true);
        this._window.loadFile(htmlPath);

        this._window.on('close', () => this._saveConfig());
        this._window.on('closed', () => (this._window = null));
        this._window.on('resize', () => this._saveConfig());
        this._window.on('move', () => this._saveConfig());
        this._window.webContents.on('did-finish-load', () => {
            if (this.config.passthrough) {
                this.setPassthrough(true);
            }
        });

        return this._window;
    }

    /** Retrieves the active BrowserWindow instance. */
    getWindow() {
        if (!this._window) {
            throw 'The window has not been created yet. Call create() first.';
        }
        return this._window;
    }

    // --- Window State & Control Methods ---

    setPosition(x, y) { this.getWindow().setPosition(x, y); }
    getPosition() { return this.getWindow().getPosition(); }

    setSize(width, height) { this.getWindow().setSize(width, height); }
    getSize() { return this.getWindow().getSize(); }
    getMinimumSize() { return this.getWindow().getMinimumSize(); }

    setPassthrough(enabled) {
        this.config.passthrough = enabled;
        const win = this.getWindow();
        if (enabled) {
            win.setIgnoreMouseEvents(true, { forward: true });
        } else {
            win.setIgnoreMouseEvents(false);
        }
        win.webContents.send('passthrough-toggled', enabled);
    }

    togglePassthrough() { this.setPassthrough(!this.config.passthrough); }
    getPassthrough() { return this.config.passthrough; }

    minimizeOrRestore() {
        const minHeight = this.getMinimumSize()[1];
        const [width, currentHeight] = this.getSize();

        if (currentHeight === minHeight) {
            this.setSize(width, this.config.lastHeight);
        } else {
            this.config.lastHeight = currentHeight;
            this.setSize(width, minHeight);
        }
    }

    loadURL(url) { this._window.loadURL(url); }
}

const window = new Window();
export default window;
