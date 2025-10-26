import { UserData } from '../models/UserData.js';
import { Lock } from '../models/Lock.js';
import { config } from '../config.js';
import socket from './Socket.js';
import logger from './Logger.js';
import fsPromises from 'fs/promises';
import path from 'path';
import * as Sessions from './Sessions.js';
import * as crypto from 'crypto';
import mapNames from '../tables/map_names.json' with { type: 'json' };

class UserDataManager {
    constructor(logger) {
        this.users = new Map();
        this.userCache = new Map();
        this.cacheFilePath = './users.json';

        this.saveThrottleDelay = 2000;
        this.saveThrottleTimer = null;
        this.pendingSave = false;

        this.hpCache = new Map();
        this.startTime = Date.now();

        this.logLock = new Lock();
        this.logDirExist = new Set();

        // Session en cours (non persistée) + guard hooks
        this.currentSession = null;
        this._shutdownHookBound = false;

        this.enemyCache = {
            name: new Map(),
            hp: new Map(),
            maxHp: new Map(),
        };

        // Auto-save des logs JSON
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        setInterval(() => {
            if (this.lastLogTime < this.lastAutoSaveTime) return;
            this.lastAutoSaveTime = Date.now();
            this.saveAllUserData();
        }, 10 * 1000);

        // Clean des joueurs inactifs
        setInterval(() => {
            this.cleanUpInactiveUsers();
        }, 30 * 1000);
    }

    /* ───────────────────────── lifecycle ───────────────────────── */

    async init() {
        await this.loadUserCache();
        this._bindShutdownHooksOnce();
    }

    _bindShutdownHooksOnce() {
        if (this._shutdownHookBound) return;
        this._shutdownHookBound = true;

        const finalize = (tag) => {
            try {
                // Persist la session en cours si présente
                this._finalizeAndPersistSession(tag || 'process_exit');
            } catch (e) {
                logger.error('[SESSION] finalize on shutdown failed:', e);
            }
        };

        process.on('SIGINT', () => { finalize('SIGINT'); process.exit(0); });
        process.on('SIGTERM', () => { finalize('SIGTERM'); process.exit(0); });
        process.on('beforeExit', () => finalize('beforeExit'));
        process.on('exit', () => finalize('exit'));
    }

    /* ───────────────────────── housekeeping ───────────────────────── */

    // Retire les joueurs inactifs > 60s
    cleanUpInactiveUsers() {
        const inactiveThreshold = 60 * 1000;
        const currentTime = Date.now();

        for (const [uid, user] of this.users.entries()) {
            if (currentTime - user.lastUpdateTime > inactiveThreshold) {
                socket.emit('user_deleted', { uid });
                this.users.delete(uid);
                logger.info(`Removed inactive user with uid ${uid}`);
            }
        }
    }

    async loadUserCache() {
        try {
            await fsPromises.access(this.cacheFilePath);
            const data = await fsPromises.readFile(this.cacheFilePath, 'utf8');
            const cacheData = JSON.parse(data);
            this.userCache = new Map(Object.entries(cacheData));
            logger.info(`Loaded ${this.userCache.size} user cache entries`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Failed to load user cache:', error);
            }
        }
    }

    async saveUserCache() {
        try {
            const cacheData = Object.fromEntries(this.userCache);
            await fsPromises.writeFile(this.cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
        } catch (error) {
            logger.error('Failed to save user cache:', error);
        }
    }

    saveUserCacheThrottled() {
        this.pendingSave = true;
        if (this.saveThrottleTimer) clearTimeout(this.saveThrottleTimer);
        this.saveThrottleTimer = setTimeout(async () => {
            if (this.pendingSave) {
                await this.saveUserCache();
                this.pendingSave = false;
                this.saveThrottleTimer = null;
            }
        }, this.saveThrottleDelay);
    }

    async forceUserCacheSave() {
        await this.saveAllUserData(this.users, this.startTime);
        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
            this.saveThrottleTimer = null;
        }
        if (this.pendingSave) {
            await this.saveUserCache();
            this.pendingSave = false;
        }
    }

    /* ───────────────────────── user data API ───────────────────────── */

    getUser(uid) {
        if (!this.users.has(uid)) {
            const user = new UserData(uid);
            const cachedData = this.userCache.get(String(uid));
            if (cachedData) {
                if (cachedData.name) user.setName(cachedData.name);
                if (cachedData.profession) user.setProfession(cachedData.profession);
                if (cachedData.subProfession) user.setSubProfession(cachedData.subProfession);
                if (cachedData.fightPoint != null) user.setFightPoint(cachedData.fightPoint);
                if (cachedData.maxHp != null) user.setAttrKV('max_hp', cachedData.maxHp);
            }
            if (this.hpCache.has(uid)) user.setAttrKV('hp', this.hpCache.get(uid));
            this.users.set(uid, user);
        }
        return this.users.get(uid);
    }

    addDamage(uid, skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0, targetUid) {
        if (config.IS_PAUSED) return;
        if (config.GLOBAL_SETTINGS.onlyRecordEliteDummy && targetUid !== 75) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue);
    }

    addHealing(uid, skillId, element, healing, isCrit, isLucky, isCauseLucky, targetUid) {
        if (config.IS_PAUSED) return;
        this.checkTimeoutClear();
        if (uid !== 0) {
            const user = this.getUser(uid);
            user.addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky);
        }
    }

    addTakenDamage(uid, damage, isDead) {
        if (config.IS_PAUSED) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addTakenDamage(damage, isDead);
    }

    async addLog(log) {
        if (config.IS_PAUSED) return;

        const logDir = path.join('./logs', String(this.startTime));
        const logFile = path.join(logDir, 'fight.log');
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${log}\n`;

        this.lastLogTime = Date.now();

        await this.logLock.acquire();
        try {
            if (!this.logDirExist.has(logDir)) {
                try { await fsPromises.access(logDir); }
                catch { await fsPromises.mkdir(logDir, { recursive: true }); }
                this.logDirExist.add(logDir);
            }
            await fsPromises.appendFile(logFile, logEntry, 'utf8');
        } catch (error) {
            logger.error('Failed to save log:', error);
        }
        this.logLock.release();
    }

    setProfession(uid, profession) {
        const user = this.getUser(uid);
        if (user.profession !== profession) {
            user.setProfession(profession);
            logger.info(`Found profession ${profession} for uid ${uid}`);
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) this.userCache.set(uidStr, {});
            this.userCache.get(uidStr).profession = profession;
            this.saveUserCacheThrottled();
        }
    }

    setName(uid, name) {
        const user = this.getUser(uid);
        if (user.name !== name) {
            user.setName(name);
            logger.info(`Found player name ${name} for uid ${uid}`);
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) this.userCache.set(uidStr, {});
            this.userCache.get(uidStr).name = name;
            this.saveUserCacheThrottled();
        }
    }

    setFightPoint(uid, fightPoint) {
        const user = this.getUser(uid);
        if (user.fightPoint != fightPoint) {
            user.setFightPoint(fightPoint);
            logger.info(`Found fight point ${fightPoint} for uid ${uid}`);
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) this.userCache.set(uidStr, {});
            this.userCache.get(uidStr).fightPoint = fightPoint;
            this.saveUserCacheThrottled();
        }
    }

    setAttrKV(uid, key, value) {
        const user = this.getUser(uid);
        user.attr[key] = value;
        if (key === 'max_hp') {
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) this.userCache.set(uidStr, {});
            this.userCache.get(uidStr).maxHp = value;
            this.saveUserCacheThrottled();
        }
        if (key === 'hp') {
            this.hpCache.set(uid, value);
        }
    }

    updateAllRealtimeDps() {
        for (const user of this.users.values()) user.updateRealtimeDps();
    }

    getUserSkillData(uid) {
        const numericUid = typeof uid === 'string' ? Number(uid) : uid;
        const user = this.users.get(numericUid);
        if (!user) return null;
        return {
            uid: user.uid,
            name: user.name,
            profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
            skills: user.getSkillSummary(),
            attr: user.attr,
        };
    }

    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users.entries()) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    getAllEnemiesData() {
        const result = {};
        const enemyIds = new Set([
            ...this.enemyCache.name.keys(),
            ...this.enemyCache.hp.keys(),
            ...this.enemyCache.maxHp.keys(),
        ]);
        enemyIds.forEach((id) => {
            result[id] = {
                name: this.enemyCache.name.get(id),
                hp: this.enemyCache.hp.get(id),
                max_hp: this.enemyCache.maxHp.get(id),
            };
        });
        return result;
    }

    deleteEnemyData(id) {
        this.enemyCache.name.delete(id);
        this.enemyCache.hp.delete(id);
        this.enemyCache.maxHp.delete(id);
    }

    refreshEnemyCache() {
        this.enemyCache.name.clear();
        this.enemyCache.hp.clear();
        this.enemyCache.maxHp.clear();
    }

    clearAll() {
        const usersToSave = this.users;
        const saveStartTime = this.startTime;
        this.users = new Map();
        this.startTime = Date.now();
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        this.saveAllUserData(usersToSave, saveStartTime);
    }

    getUserIds() {
        return Array.from(this.users.keys());
    }

    async saveAllUserData(usersToSave = null, startTime = null) {
        try {
            const endTime = Date.now();
            const users = usersToSave || this.users;
            const timestamp = startTime || this.startTime;
            const logDir = path.join('./logs', String(timestamp));
            const usersDir = path.join(logDir, 'users');
            const summary = {
                startTime: timestamp,
                endTime,
                duration: endTime - timestamp,
                userCount: users.size,
                version: config.VERSION,
            };

            const allUsersData = {};
            const userDatas = new Map();
            for (const [uid, user] of users.entries()) {
                allUsersData[uid] = user.getSummary();
                const userData = {
                    uid: user.uid,
                    name: user.name,
                    profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
                    subProfession: user.subProfession,
                    skills: user.getSkillSummary(),
                    attr: user.attr,
                };
                userDatas.set(uid, userData);
            }

            try { await fsPromises.access(usersDir); }
            catch { await fsPromises.mkdir(usersDir, { recursive: true }); }

            const allUserDataPath = path.join(logDir, 'allUserData.json');
            await fsPromises.writeFile(allUserDataPath, JSON.stringify(allUsersData, null, 2), 'utf8');
            for (const [uid, userData] of userDatas.entries()) {
                const userDataPath = path.join(usersDir, `${uid}.json`);
                await fsPromises.writeFile(userDataPath, JSON.stringify(userData, null, 2), 'utf8');
            }
            await fsPromises.writeFile(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
            logger.debug(`Saved data for ${summary.userCount} users to ${logDir}`);
        } catch (error) {
            logger.error('Failed to save all user data:', error);
            throw error;
        }
    }

    checkTimeoutClear() {
        if (!config.GLOBAL_SETTINGS.autoClearOnTimeout || this.lastLogTime === 0 || this.users.size === 0) return;
        const currentTime = Date.now();
        if (this.lastLogTime && currentTime - this.lastLogTime > 15000) {
            this.clearAll();
            logger.info('Timeout reached, statistics cleared!');
        }
    }

    getGlobalSettings() {
        return config.GLOBAL_SETTINGS;
    }

    /* ───────────────────────── sessions glue ───────────────────────── */

    /** Construit l’objet joueur attendu par sessions.js */
    _buildPlayerSnapshot(uid) {
        const u = this.users.get(uid);
        if (!u) return null;

        const sum = u.getSummary();
        const totalDamage = Number(sum.total_damage?.total || 0);
        const totalHeal = Number(sum.total_healing?.total || 0);

        // ⛔️ Skip joueurs sans dégâts et sans soins
        if (totalDamage <= 0 && totalHeal <= 0) return null;

        const skills = u.getSkillSummary() || {};

        // Top sorts (damage)
        const damageSkills = Object.values(skills)
            .filter(s => (s.type || '').toLowerCase() === 'damage');
        const topDamageSpells = damageSkills
            .map(s => ({
                id: s.id || s.skillId || s.displayName,
                name: s.displayName || String(s.id || s.skillId || 'Skill'),
                damage: Number(s.totalDamage || s.total || 0),
            }))
            .sort((a, b) => b.damage - a.damage)
            .slice(0, 3);

        // Top sorts (healing)
        const healSkills = Object.values(skills)
            .filter(s => (s.type || '').toLowerCase() === 'healing');
        const topHealSpells = healSkills
            .map(s => ({
                id: s.id || s.skillId || s.displayName,
                name: s.displayName || String(s.id || s.skillId || 'Skill'),
                heal: Number(s.totalHealing || s.total || 0),
            }))
            .sort((a, b) => (b.heal - a.heal))
            .slice(0, 3);

        return {
            uid: u.uid,
            name: u.name || String(u.uid),
            // le viewer regarde "profession" et devine la classe/icône
            profession: u.profession + (u.subProfession ? ` ${u.subProfession}` : ''),
            fightPoint: u.fightPoint,

            // champs que sessions.js lit directement
            dps: Number(sum.total_dps || 0),
            hps: Number(sum.total_hps || 0),
            totals: {
                damage: Number(sum.total_damage?.total || 0),
                heal: Number(sum.total_healing?.total || 0),
            },

            topDamageSpells,
            topHealSpells,

            // utile si tu veux afficher plus tard
            attr: u.attr || {},
        };
    }


    onInstanceChanged(seq, reason, extra = {}) {
        logger.info(`[INSTANCE] Change detected: reason=${reason}, seq=${seq}, to=${extra?.to}`);

        // 1) Finalise l'ancienne session (snapshot avant clear)
        if (this.currentSession) {
            const endedAt = Date.now();
            const snapshotUsers = this.getAllUsersData();
            const players = this.getUserIds()
                .map(uid => this._buildPlayerSnapshot(uid))
                .filter(Boolean);

            if (players.length === 0) {
                logger.info('[SESSION] Skip persist on instance change: empty session.');
            } else {
                const sessionToSave = {
                    id: this.currentSession.id,
                    name: this.currentSession.name,
                    startedAt: this.currentSession.startedAt,
                    endedAt,
                    durationMs: Math.max(0, endedAt - this.currentSession.startedAt),
                    reasonEnd: reason || 'instance_change',
                    seq: this.currentSession.seq,
                    instanceId: this.currentSession.instanceId,
                    fromInstance: this.currentSession.fromInstance,
                    partySize: players.length,
                    snapshot: { players, usersAgg: snapshotUsers },
                };

                try {
                    Sessions.addSession(sessionToSave);
                    logger.info(`[SESSION] Persisted ${sessionToSave.name} (${sessionToSave.partySize} joueurs)`);
                } catch (e) {
                    logger.error('[SESSION] Failed to persist session:', e);
                }
            }

            this.currentSession = null;
        }

        // 2) Reset complet du meter
        this.clearAll();

        // 3) Nom lisible = nom de la map + date/heure locale
        const mapId = extra?.to ?? seq;
        const mapName = mapNames[String(mapId)] || `Instance ${mapId}`;
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const sessionName =
            `${mapName} — ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        // 4) Démarre la nouvelle session en mémoire
        this.currentSession = {
            id: crypto.randomUUID(),
            name: sessionName,
            startedAt: Date.now(),
            reasonStart: reason,
            seq,
            instanceId: mapId,
            fromInstance: extra?.from ?? null,
        };

        logger.info(`[SESSION] Started new session: ${sessionName}`);

        // 5) Notifie le front (reset UI)
        socket.emit('session_started', {
            id: this.currentSession.id,
            name: this.currentSession.name,
            startedAt: this.currentSession.startedAt,
            instanceId: this.currentSession.instanceId,
            fromInstance: this.currentSession.fromInstance,
            seq: this.currentSession.seq,
            reasonStart: this.currentSession.reasonStart,
        });
        socket.emit('dps_cleared', { at: Date.now() });
        socket.emit('session_changed', { seq, reason, ...extra }); // compat
    }

    _finalizeAndPersistSession(reasonEnd = 'instance_change') {
        if (!this.currentSession) return;

        const endedAt = Date.now();
        const snapshotUsers = this.getAllUsersData();

        const players = this.getUserIds()
            .map(uid => this._buildPlayerSnapshot(uid)) // <- déjà en place
            .filter(Boolean);

        // ⛔️ Rien à sauvegarder si aucun joueur n’a fait de dmg/soin
        if (players.length === 0) {
            this.currentSession = null;               // on clôt quand même la session en mémoire
            logger.info('[SESSION] Skip persist: empty session (no active players).');
            return;
        }

        const sessionToSave = {
            id: this.currentSession.id,
            name: this.currentSession.name,
            startedAt: this.currentSession.startedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - this.currentSession.startedAt),
            reasonStart: this.currentSession.reasonStart,
            reasonEnd,
            seq: this.currentSession.seq,
            instanceId: this.currentSession.instanceId,
            fromInstance: this.currentSession.fromInstance,
            partySize: players.length,
            snapshot: { usersAgg: snapshotUsers, players },
        };

        try {
            Sessions.addSession(sessionToSave);
            logger.info(`[SESSION] Persisted: ${sessionToSave.name} (${sessionToSave.partySize} joueurs)`);
        } catch (e) {
            logger.error('[SESSION] Failed to persist session:', e);
        } finally {
            this.currentSession = null;
        }
    }

    /**
 * Démarre une nouvelle session vide (utilisée après un clear manuel ou un restart).
 * Construit toujours un nom horodaté complet avec secondes.
 */
    _startNewSession(extra = {}, reason = 'manual_restart') {
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const timestamp =
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
            `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        // Nom de base prioritaire : mapNameBase > mapName > instanceId > fallback
        const baseName =
            extra.mapNameBase ||
            extra.mapName ||
            (extra.to != null ? (mapNames[String(extra.to)] || `Instance ${extra.to}`) : null) ||
            'Manual Restart';

        const sessionName = `${baseName} — ${timestamp}`;

        // Création de la nouvelle session en mémoire
        this.currentSession = {
            id: crypto.randomUUID(),
            name: sessionName,
            startedAt: Date.now(),
            reasonStart: reason,
            seq: extra.seq ?? undefined,
            instanceId: extra.to ?? null,
            fromInstance: extra.from ?? null,
        };

        logger.info(`[SESSION] Started new session: ${sessionName}`);

        // Notifie l’UI pour reset l’affichage
        socket.emit('session_started', {
            id: this.currentSession.id,
            name: this.currentSession.name,
            startedAt: this.currentSession.startedAt,
            instanceId: this.currentSession.instanceId,
            fromInstance: this.currentSession.fromInstance,
            seq: this.currentSession.seq,
            reasonStart: this.currentSession.reasonStart,
        });
        socket.emit('dps_cleared', { at: Date.now() });
    }

}

const userDataManager = new UserDataManager();
export default userDataManager;
