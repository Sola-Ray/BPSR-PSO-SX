// src/server.js (ESM)
import cors from 'cors';
import express from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { createApiRouter } from './routes/api.js';
import { PacketInterceptor } from './services/PacketInterceptor.js';
import userDataManager from './services/UserDataManager.js';
import socket from './services/Socket.js';
import logger from './services/Logger.js';
import sessionsRoutesMaybe from './routes/sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isPaused = false;

class Server {
    /** @param {{ publicDir:string, settingsPath:string, logsDir:string }} paths */
    start = async (paths) =>
        new Promise(async (resolve, reject) => {
            try {
                this.paths = paths;
                await this._ensureDirs();
                await this._loadGlobalSettings();

                const app = express();
                app.use(cors());
                app.use(express.static(paths.publicDir));
                app.get('/', (_req, res) => {
                    res.sendFile(path.join(paths.publicDir, 'index.html'));
                });


                app.get('/share-canvas', (_req, res) => {
                    res.sendFile(path.join(paths.publicDir, 'share-canvas.html'));
                });

                // --------- API router (avec garde + logs) ----------
                if (typeof createApiRouter !== 'function') {
                    throw new Error('[server] createApiRouter import is not a function. Check routes/api.js export.');
                }

                let apiRouter;
                try {
                    apiRouter = createApiRouter(isPaused, paths.settingsPath, paths.logsDir);
                } catch (e) {
                    console.error('[server] createApiRouter threw:', e);
                    throw e;
                }

                if (typeof apiRouter !== 'function') {
                    console.error('[server] typeof apiRouter =', typeof apiRouter, apiRouter);
                    throw new Error('[server] createApiRouter did not return an Express Router.');
                }
                app.use('/api', apiRouter);

                // --------- Sessions routes (Router ou Factory) ------
                let sessionsRoutes = sessionsRoutesMaybe;
                if (typeof sessionsRoutesMaybe === 'function' && sessionsRoutesMaybe.name) {
                    // Si c’est une factory(logsDir), on l’appelle (elle doit renvoyer un Router)
                    try {
                        const maybeRouter = sessionsRoutesMaybe(this.paths.logsDir);
                        if (typeof maybeRouter === 'function') {
                            sessionsRoutes = maybeRouter;
                        }
                    } catch (e) {
                        console.warn('[server] sessions routes factory failed, skipping:', e);
                        sessionsRoutes = null;
                    }
                }
                if (sessionsRoutes && typeof sessionsRoutes === 'function') {
                    app.use('/api/sessions', sessionsRoutes);
                } else {
                    console.warn('[server] sessionsRoutes not mounted (not a middleware).');
                }

                this.server = http.createServer(app);
                this.server.on('error', (err) => reject(err));

                socket.init(this.server);
                userDataManager.init();

                this._configureProcessEvents();
                this._configureSocketEmitter();
                this._configureSocketListener();

                // ---------- Port libre ----------
                const checkPort = (port) =>
                    new Promise((res) => {
                        const s = net.createServer();
                        s.once('error', () => res(false));
                        s.once('listening', () => s.close(() => res(true)));
                        s.listen(port);
                    });

                let server_port = 8990;
                while (!(await checkPort(server_port))) {
                    logger.warn(`port ${server_port} is already in use`);
                    server_port++;
                }

                // ---------- Interceptor + URL sûre ----------
                const safeResolve = (url) => {
                    const finalUrl = url || `http://localhost:${server_port}`;
                    resolve(finalUrl);
                };
                PacketInterceptor.start(this.server, server_port, safeResolve, reject);
            } catch (error) {
                console.error('Error during server startup:', error);
                reject(error);
            }
        });

    async _ensureDirs() {
        try { await fsPromises.mkdir(this.paths.logsDir, { recursive: true }); } catch { }
        try {
            await fsPromises.access(this.paths.settingsPath);
        } catch {
            await fsPromises.writeFile(
                this.paths.settingsPath,
                JSON.stringify(
                    {
                        autoClearOnServerChange: true,
                        autoClearOnTimeout: false,
                        onlyRecordEliteDummy: false,
                    },
                    null,
                    2
                ),
                'utf8'
            );
        }
    }

    _configureProcessEvents() {
        const graceful = () => userDataManager.forceUserCacheSave().then(() => process.exit(0));
        process.on('SIGINT', graceful);
        process.on('SIGTERM', graceful);
    }

    _configureSocketEmitter() {
        setInterval(() => {
            if (!isPaused) {
                userDataManager.updateAllRealtimeDps();
                const userData = userDataManager.getAllUsersData();
                const skillData = {};
                for (const uid in userData) {
                    if (Object.prototype.hasOwnProperty.call(userData, uid)) {
                        skillData[uid] = userDataManager.getUserSkillData(uid);
                    }
                }
                socket.emit('data', { code: 0, user: userData, skills: skillData });
            }
        }, 100);
    }

    _configureSocketListener() {
        socket.on('connection', (sock) => {
            logger.info(`WebSocket client connected: ${sock.id}`);
            sock.on('disconnect', () => {
                logger.info(`WebSocket client disconnected: ${sock.id}`);
            });
        });
    }

    async _loadGlobalSettings() {
        try {
            const data = await fsPromises.readFile(this.paths.settingsPath, 'utf8');
            globalThis.globalSettings = { ...(globalThis.globalSettings || {}), ...JSON.parse(data) };
        } catch {
            // premier lancement possible
        }
    }
}

const server = new Server();
export default server;
