// routes/api.js
import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import logger from '../services/Logger.js';
import userDataManager from '../services/UserDataManager.js';
import socket from '../services/Socket.js';
import * as Sessions from '../services/Sessions.js';
import mapNames from '../tables/map_names.json' with { type: 'json' };

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const JSON_OK = (payload = {}) => ({ code: 0, ...payload });
const JSON_ERR = (msg, extra = {}) => ({ code: 1, msg: String(msg), ...extra });

/** Wrappe un handler async pour que les erreurs passent au middleware d’erreur. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Vérifie qu’une valeur n’est composée que de chiffres. */
const isDigits = (s) => typeof s === 'string' && /^\d+$/.test(s);

const pad2 = (n) => String(n).padStart(2, '0');

/** Supprime un timestamp suffixe du style " — 2025-10-26 23:59" ou " - 2025/10/26 23:59:59". */
const stripTimestamp = (raw) =>
    String(raw ?? '').replace(/\s*[—–-]\s*\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/, '');

/** Construit un nom de session lisible. */
const buildSessionName = (base) => {
    const now = new Date();
    const date =
        `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
        `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    return `${base} — ${date}`;
};

/** Persiste la session courante si pertinente. */
const saveCurrentSessionIfAny = async () => {
    const previous = userDataManager.currentSession;
    const hadPlayers = userDataManager.getUserIds().length > 0;
    if (!previous || !hadPlayers) return { saved: false };

    const savedUsers = new Map(userDataManager.users);
    const snapshotUsers = userDataManager.getAllUsersData();

    const players = Array.from(savedUsers.keys())
        .map((uid) => userDataManager._buildPlayerSnapshot(uid))
        .filter(Boolean);

    if (players.length === 0) {
        logger.info('[SESSION] Skipped save: no valid players.');
        return { saved: false };
    }

    const endedAt = Date.now();
    const sessionToSave = {
        id: previous.id,
        name: previous.name,
        startedAt: previous.startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - previous.startedAt),
        reasonStart: previous.reasonStart,
        reasonEnd: 'manual_clear',
        seq: previous.seq,
        instanceId: previous.instanceId,
        fromInstance: previous.fromInstance,
        partySize: players.length,
        snapshot: { usersAgg: snapshotUsers, players },
    };

    await Sessions.addSession(sessionToSave);
    logger.info(`[SESSION] Persisted before clear → ${sessionToSave.name}`);
    return { saved: true, session: sessionToSave };
};

/* -------------------------------------------------------------------------- */
/*                               Router factory                               */
/* -------------------------------------------------------------------------- */

/**
 * Crée un Router Express configuré.
 * @param {boolean} isPausedInit État initial pause.
 * @param {string} SETTINGS_PATH Chemin du fichier de settings (RW).
 * @param {string} LOGS_DIR Dossier racine des logs/historiques (RW).
 * @returns {import('express').Router}
 */
export function createApiRouter(isPausedInit, SETTINGS_PATH, LOGS_DIR) {
    let isPaused = Boolean(isPausedInit);
    const router = express.Router();

    /** Empêche la traversée de répertoires dans LOGS_DIR. */
    const safeJoinLogs = (...segments) => {
        const base = path.resolve(LOGS_DIR);
        const abs = path.resolve(base, ...segments);
        if (!abs.startsWith(base)) {
            throw new Error('Unsafe path');
        }
        return abs;
    };

    // Middleware JSON
    router.use(express.json());

    // --------------------------- LIVE DATA ------------------------------------

    router.get('/data', (_req, res) => {
        res.json(JSON_OK({ user: userDataManager.getAllUsersData() }));
    });

    router.get('/enemies', (_req, res) => {
        res.json(JSON_OK({ enemy: userDataManager.getAllEnemiesData() }));
    });

    // ---------------------- CLEAR + AUTO-RESTART ------------------------------

    router.get(
        '/clear',
        asyncHandler(async (_req, res) => {
            const previous = userDataManager.currentSession;

            // 1) Sauvegarde éventuelle
            await saveCurrentSessionIfAny();

            // 2) Reset complet
            userDataManager.clearAll();
            logger.info('Statistics cleared!');

            // 3) Notifie la fin
            socket.emit('session_ended', { reason: 'manual_clear', at: Date.now() });

            // 4) Base name
            const baseName =
                (previous?.instanceId != null && mapNames[String(previous.instanceId)]) ||
                stripTimestamp(previous?.name) ||
                previous?.mapName ||
                previous?.instanceName ||
                'Manual Restart';

            const sessionName = buildSessionName(baseName);

            // 5) Démarre une nouvelle session vide
            userDataManager._startNewSession?.({ mapNameBase: baseName }, 'manual_restart');

            // 6) Notifie l’UI
            socket.emit('session_started', {
                id: userDataManager.currentSession?.id,
                name: userDataManager.currentSession?.name,
                startedAt: userDataManager.currentSession?.startedAt,
                reasonStart: 'manual_restart',
            });
            socket.emit('dps_cleared', { at: Date.now() });

            logger.info(`[SESSION] Auto restarted after manual clear → ${sessionName}`);

            // 7) Réponse
            res.json(JSON_OK({ msg: `Statistics cleared and new session started on map "${sessionName}"` }));
        })
    );

    // ---------------------------- PAUSE ---------------------------------------

    router.post('/pause', (req, res) => {
        const { paused } = req.body ?? {};
        isPaused = Boolean(paused);
        const msg = `Statistics ${isPaused ? 'paused' : 'resumed'}!`;
        logger.info(msg);
        res.json(JSON_OK({ msg, paused: isPaused }));
    });

    router.get('/pause', (_req, res) => {
        res.json(JSON_OK({ paused: isPaused }));
    });

    // --------------------------- SKILL (live) ---------------------------------

    router.get('/skill/:uid', (req, res) => {
        const uid = Number.parseInt(req.params.uid, 10);
        if (Number.isNaN(uid)) return res.status(400).json(JSON_ERR('Invalid uid'));
        const skillData = userDataManager.getUserSkillData(uid);
        if (!skillData) return res.status(404).json(JSON_ERR('User not found'));
        res.json(JSON_OK({ data: skillData }));
    });

    // ----------------------- HISTORY FILES (logs/) ----------------------------

    router.get(
        '/history/:timestamp/summary',
        asyncHandler(async (req, res) => {
            const { timestamp } = req.params;
            if (!isDigits(timestamp)) return res.status(400).json(JSON_ERR('Invalid timestamp'));

            const file = safeJoinLogs(timestamp, 'summary.json');
            try {
                const data = await fs.readFile(file, 'utf8');
                res.json(JSON_OK({ data: JSON.parse(data) }));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    logger.warn('History summary file not found:', error);
                    return res.status(404).json(JSON_ERR('History summary file not found'));
                }
                logger.error('Failed to read history summary file:', error);
                res.status(500).json(JSON_ERR('Failed to read history summary file'));
            }
        })
    );

    router.get(
        '/history/:timestamp/data',
        asyncHandler(async (req, res) => {
            const { timestamp } = req.params;
            if (!isDigits(timestamp)) return res.status(400).json(JSON_ERR('Invalid timestamp'));

            const file = safeJoinLogs(timestamp, 'allUserData.json');
            try {
                const data = await fs.readFile(file, 'utf8');
                res.json(JSON_OK({ user: JSON.parse(data) }));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    logger.warn('History data file not found:', error);
                    return res.status(404).json(JSON_ERR('History data file not found'));
                }
                logger.error('Failed to read history data file:', error);
                res.status(500).json(JSON_ERR('Failed to read history data file'));
            }
        })
    );

    router.get(
        '/history/:timestamp/skill/:uid',
        asyncHandler(async (req, res) => {
            const { timestamp } = req.params;
            const uid = Number.parseInt(req.params.uid, 10);
            if (!isDigits(timestamp)) return res.status(400).json(JSON_ERR('Invalid timestamp'));
            if (Number.isNaN(uid)) return res.status(400).json(JSON_ERR('Invalid uid'));

            const file = safeJoinLogs(timestamp, 'users', `${uid}.json`);
            try {
                const data = await fs.readFile(file, 'utf8');
                res.json(JSON_OK({ data: JSON.parse(data) }));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    logger.warn('History skill file not found:', error);
                    return res.status(404).json(JSON_ERR('History skill file not found'));
                }
                logger.error('Failed to read history skill file:', error);
                res.status(500).json(JSON_ERR('Failed to read history skill file'));
            }
        })
    );

    router.get(
        '/history/:timestamp/download',
        asyncHandler(async (req, res) => {
            const { timestamp } = req.params;
            if (!isDigits(timestamp)) return res.status(400).json(JSON_ERR('Invalid timestamp'));

            const file = safeJoinLogs(timestamp, 'fight.log');

            try {
                await fs.access(file);
            } catch {
                logger.warn('History fight.log not found:', file);
                return res.status(404).json(JSON_ERR('History log not found'));
            }

            res.download(file, `fight_${timestamp}.log`);
        })
    );

    router.get(
        '/history/list',
        asyncHandler(async (_req, res) => {
            try {
                const entries = await fs.readdir(LOGS_DIR, { withFileTypes: true });
                const data = entries.filter((e) => e.isDirectory() && isDigits(e.name)).map((e) => e.name);
                res.json(JSON_OK({ data }));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    logger.warn('History path not found:', error);
                    return res.status(404).json(JSON_ERR('History path not found'));
                }
                logger.error('Failed to load history path:', error);
                res.status(500).json(JSON_ERR('Failed to load history path'));
            }
        })
    );

    // ---------------------------- SESSIONS ------------------------------------

    router.get('/sessions', (_req, res) => {
        try {
            const list = Sessions.listSessions();
            res.json(JSON_OK({ data: list }));
        } catch (e) {
            logger.error('[GET /api/sessions] error:', e);
            res.status(500).json(JSON_ERR(e));
        }
    });

    router.get('/sessions/:id', (req, res) => {
        try {
            const sess = Sessions.getSession(req.params.id);
            if (!sess) return res.status(404).json(JSON_ERR('Session not found'));

            const partySize =
                (typeof sess.partySize === 'number' ? sess.partySize : undefined) ??
                (typeof sess.playersCount === 'number' ? sess.playersCount : undefined) ??
                (Array.isArray(sess?.snapshot?.players) ? sess.snapshot.players.length : 0);

            res.json(JSON_OK({ data: { ...sess, partySize } }));
        } catch (e) {
            logger.error('[GET /api/sessions/:id] error:', e);
            res.status(500).json(JSON_ERR(e));
        }
    });

    router.delete('/sessions/:id', (req, res) => {
        try {
            const ok = Sessions.deleteSession(req.params.id);
            if (!ok) return res.status(404).json(JSON_ERR('Session not found'));
            res.json(JSON_OK());
        } catch (e) {
            logger.error('[DELETE /api/sessions/:id] error:', e);
            res.status(500).json(JSON_ERR(e));
        }
    });

    // ----------------------------- SETTINGS -----------------------------------

    const readGlobalSettings = () => globalThis.globalSettings ?? {};
    const writeGlobalSettings = async (next) => {
        globalThis.globalSettings = next;
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
    };

    router.get('/settings', (_req, res) => {
        res.json(JSON_OK({ data: readGlobalSettings() }));
    });

    router.post(
        '/settings',
        asyncHandler(async (req, res) => {
            const incoming = req.body && typeof req.body === 'object' ? req.body : {};
            const merged = { ...readGlobalSettings(), ...incoming };
            await writeGlobalSettings(merged);
            res.json(JSON_OK({ data: merged }));
        })
    );

    /* ------------------------ Middleware d’erreur JSON ----------------------- */
    // eslint-disable-next-line no-unused-vars
    router.use((err, _req, res, _next) => {
        logger.error('[API ERROR]', err);
        res.status(500).json(JSON_ERR('Internal error'));
    });

    return router;
}
