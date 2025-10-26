// src/services/PacketProcessor.js
// ESM, Node 18+ requis

import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Long from 'long';
import pbjs from 'protobufjs/minimal.js';

import loggerMod from './Logger.js';
const logger = loggerMod?.default ?? loggerMod;

import monsterNames from '../tables/monster_names.json' with { type: 'json' };

import * as BinaryReaderNS from '../models/BinaryReader.js';
const BinaryReader = BinaryReaderNS?.BinaryReader ?? BinaryReaderNS?.default ?? BinaryReaderNS;

import * as udmNS from './UserDataManager.js';
const userDataManager = udmNS?.default ?? udmNS;

import * as pbRaw from '../algo/blueprotobuf.js';
const pb = pbRaw?.default ?? pbRaw;

import { InstanceTracker } from './InstanceTracker.js';

import {
    dumpSnapshot,
    findInterestingFields,
    diffInteresting,
} from '../debog/DebugVDataInspector.js';

/* =========================
 * Constantes / Enums
 * =======================*/
const MessageType = Object.freeze({
    None: 0, Call: 1, Notify: 2, Return: 3, Echo: 4, FrameUp: 5, FrameDown: 6,
});

const NotifyMethod = Object.freeze({
    SyncNearEntities: 0x00000006,
    SyncContainerData: 0x00000015,
    SyncContainerDirtyData: 0x00000016,
    SyncServerTime: 0x0000002b,
    SyncNearDeltaInfo: 0x0000002d,
    SyncToMeDeltaInfo: 0x0000002e,
});

// ServiceId connu pour les notifies
const SERVICE_UUID_NOTIFY = 0x0000000063335342n;

const localExtractSceneLikeId = (root, maxDepth = 4) => {
    const seen = new Set();
    const KEY_RX = /^(scene(Id)?|map(Id)?|level(Id)?|area(Id)?|zone(Id)?|dungeon(Id)?|chapter(Id)?|instance(Id)?|stage(Id)?|room(Id)?|copy(Id)?)$/i;

    const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > maxDepth || seen.has(obj)) return null;
        seen.add(obj);

        for (const [k, v] of Object.entries(obj)) {
            if (v == null) continue;
            if (KEY_RX.test(k)) {
                if (typeof v === 'number' && Number.isFinite(v)) return v;
                if (typeof v?.toNumber === 'function') return v.toNumber();
                if (typeof v === 'bigint') return Number(v);
            }
            if (typeof v === 'object') {
                if ('Id' in v && (typeof v.Id === 'number' || typeof v.Id?.toNumber === 'function')) {
                    if (KEY_RX.test(`${k}Id`)) return typeof v.Id?.toNumber === 'function' ? v.Id.toNumber() : v.Id;
                }
                if (typeof v.InstanceId === 'number' || typeof v.InstanceId?.toNumber === 'function') {
                    return typeof v.InstanceId?.toNumber === 'function' ? v.InstanceId.toNumber() : v.InstanceId;
                }
            }
        }

        for (const v of Object.values(obj)) {
            if (typeof v === 'object' && v) {
                const r = walk(v, depth + 1);
                if (r != null) return r;
            }
        }
        return null;
    };

    try { return walk(root, 0); } catch { return null; }
};

const AttrType = Object.freeze({
    AttrName: 0x01,
    AttrId: 0x0a,
    AttrProfessionId: 0xdc,
    AttrFightPoint: 0x272e,
    AttrLevel: 0x2710,
    AttrRankLevel: 0x274c,
    AttrCri: 0x2b66,
    AttrLucky: 0x2b7a,
    AttrHp: 0x2c2e,
    AttrMaxHp: 0x2c38,
    AttrElementFlag: 0x646d6c,
    AttrReductionLevel: 0x64696d,
    AttrReduntionId: 0x6f6c65,
    AttrEnergyFlag: 0x543cd3c6,
});

const ProfessionType = Object.freeze({
    Stormblade: 1, FrostMage: 2, FireWarrior: 3, WindKnight: 4, VerdantOracle: 5,
    Marksman_Cannon: 8, HeavyGuardian: 9, SoulMusician_Scythe: 10, Marksman: 11,
    ShieldKnight: 12, SoulMusician: 13,
});

const EDamageSource = Object.freeze({
    EDamageSourceSkill: 0,
    EDamageSourceBullet: 1,
    EDamageSourceBuff: 2,
    EDamageSourceFall: 3,
    EDamageSourceFakeBullet: 4,
    EDamageSourceOther: 100,
});

const EDamageProperty = Object.freeze({
    General: 0, Fire: 1, Water: 2, Electricity: 3, Wood: 4,
    Wind: 5, Rock: 6, Light: 7, Dark: 8, Count: 9,
});

/* =========================
 * Utils génériques
 * =======================*/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const toNum = (v) => (Long.isLong?.(v) ? v.toNumber() : Number(v));

const hexPreview = (buf, n = 24) => {
    try {
        if (!buf || typeof buf.slice !== 'function') return '';
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        return b.slice(0, n).toString('hex');
    } catch { return ''; }
};

/** Fallback intelligent: accès direct OU Root.lookupType() */
const pickDecoder = (root, paths = []) => {
    for (const p of paths) {
        const ref = p.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), root);
        if (ref && typeof ref.decode === 'function') return ref;

        if (root && typeof root.lookupType === 'function') {
            try {
                const t = root.lookupType(p);
                if (t && typeof t.decode === 'function') return t;
            } catch { /* ignore */ }
        }
    }
    return null;
};

const decodeSafely = (root, paths, payload, ctx = {}) => {
    try {
        const dec = pickDecoder(root, paths);
        if (!dec) {
            logger.error('[PB] Missing decoder', { try: paths, ...ctx, len: payload?.length });
            return null;
        }
        if (!payload?.length) {
            logger.warn('[PB] Empty payload', { for: paths[0], ...ctx });
            return null;
        }
        return dec.decode(payload);
    } catch (e) {
        logger.error('[PB] Decode error', {
            for: paths[0],
            err: e?.message || String(e),
            len: payload?.length,
            head: hexPreview(payload),
            ...ctx,
        });
        return null;
    }
};

/* =========================
 * Raccourcis métier
 * =======================*/
const getProfessionNameFromId = (id) => ({
    [ProfessionType.Stormblade]: 'Stormblade',
    [ProfessionType.FrostMage]: 'Frost Mage',
    [ProfessionType.FireWarrior]: 'Fire Warrior',
    [ProfessionType.WindKnight]: 'Wind Knight',
    [ProfessionType.VerdantOracle]: 'Verdant Oracle',
    [ProfessionType.Marksman_Cannon]: 'Gunner',
    [ProfessionType.HeavyGuardian]: 'Heavy Guardian',
    [ProfessionType.SoulMusician_Scythe]: 'Reaper',
    [ProfessionType.Marksman]: 'Marksman',
    [ProfessionType.ShieldKnight]: 'Shield Knight',
    [ProfessionType.SoulMusician]: 'Soul Musician',
}[id] ?? '');

const getDamageElement = (p) => ({
    [EDamageProperty.General]: '⚔️物',
    [EDamageProperty.Fire]: '🔥火',
    [EDamageProperty.Water]: '❄️冰',
    [EDamageProperty.Electricity]: '⚡雷',
    [EDamageProperty.Wood]: '🍀森',
    [EDamageProperty.Wind]: '💨风',
    [EDamageProperty.Rock]: '⛰️岩',
    [EDamageProperty.Light]: '🌟光',
    [EDamageProperty.Dark]: '🌑暗',
    [EDamageProperty.Count]: '❓？',
}[p] ?? '⚔️物');

const getDamageSource = (s) => ({
    [EDamageSource.EDamageSourceSkill]: 'Skill',
    [EDamageSource.EDamageSourceBullet]: 'Bullet',
    [EDamageSource.EDamageSourceBuff]: 'Buff',
    [EDamageSource.EDamageSourceFall]: 'Fall',
    [EDamageSource.EDamageSourceFakeBullet]: 'FBullet',
    [EDamageSource.EDamageSourceOther]: 'Other',
}[s] ?? 'Unknown');

const isUuidPlayer = (uuid) => ((uuid.toBigInt?.() ?? BigInt(uuid)) & 0xffffn) === 640n;
const isUuidMonster = (uuid) => ((uuid.toBigInt?.() ?? BigInt(uuid)) & 0xffffn) === 64n;

const doesStreamHaveIdentifier = (reader) => {
    const start = reader.position;
    if (reader.remaining() < 8) return false;
    let id = reader.readUInt32LE(); reader.readInt32();
    if (id !== 0xfffffffe) { reader.position = start; return false; }
    id = reader.readInt32(); reader.readInt32();
    reader.position = start;
    return true;
};

const streamReadString = (reader) => {
    const len = reader.readUInt32LE();
    reader.readInt32();
    const buf = reader.readBytes(len);
    reader.readInt32();
    return buf.toString();
};

/* =========================
 * State / Options
 * =======================*/
const INSTANCE_DEBOUNCE_MS = Number(process.env.INSTANCE_DEBOUNCE_MS ?? 0);

// Tracker d’instance (séparé)
const instanceTracker = new InstanceTracker({
    logger,
    userDataManager,
    debounceMs: INSTANCE_DEBOUNCE_MS,
    mapNamesPath: path.join(__dirname, '../tables/map_names.json'),
});

// Log d’autodiagnostic PB (une seule fois)
if (!globalThis.__PB_KEYS_LOGGED__) {
    globalThis.__PB_KEYS_LOGGED__ = true;
    try {
        const top = Object.keys(pb || {});
        logger.info(`[PB] top-level keys: ${top.join(', ')}`);
        if (typeof pb.lookupType === 'function') {
            logger.info('[PB] lookupType available (protobufjs Root).');
        }
    } catch { }
}

/* =========================
 * Classe principale
 * =======================*/
export class PacketProcessor {
    #internalBuffer = Buffer.alloc(0);
    #currentUserUuid = Long.ZERO; // on le maintient en miroir de l'InstanceTracker

    constructor() { }

    /* ---------- compression ---------- */
    #maybeDecompress(buffer, { zstdFlag } = {}) {
        try {
            if (!buffer?.length) return buffer;
            if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer);
            if (zstdFlag) {
                logger.warn('Zstd flagged but zstdDecompressSync is unavailable. Using raw payload.');
            }
            return buffer;
        } catch (e) {
            logger.warn('zstdDecompressSync failed, using raw payload', { err: e?.message });
            return buffer;
        }
    }

    /* ---------- AOI / Deltas ---------- */
    #processAoiSyncDelta(aoiSyncDelta) {
        if (!aoiSyncDelta) return;

        let targetUuid = aoiSyncDelta.Uuid;
        if (!targetUuid) return;

        const targetIsPlayer = isUuidPlayer(targetUuid);
        const targetIsMonster = isUuidMonster(targetUuid);
        targetUuid = targetUuid.shiftRight(16);

        const attrs = aoiSyncDelta?.Attrs?.Attrs;
        if (attrs?.length) {
            if (targetIsPlayer) this.#processPlayerAttrs(targetUuid.toNumber(), attrs);
            else if (targetIsMonster) this.#processEnemyAttrs(targetUuid.toNumber(), attrs);
        }

        const damages = aoiSyncDelta?.SkillEffects?.Damages;
        if (!Array.isArray(damages) || damages.length === 0) return;

        for (const d of damages) {
            const skillId = d.OwnerId;
            if (!skillId) continue;

            let attackerUuid = d.TopSummonerId || d.AttackerUuid;
            if (!attackerUuid) continue;

            const attackerIsPlayer = isUuidPlayer(attackerUuid);
            attackerUuid = attackerUuid.shiftRight(16);

            const value = d.Value;
            const luckyValue = d.LuckyValue;
            const damage = value ?? luckyValue ?? Long.ZERO;
            if (Long.isLong(damage) ? damage.isZero() : Number(damage) === 0) continue;

            const flag = d.TypeFlag ?? 0;
            const isCrit = (flag & 1) === 1;
            const isCauseLucky = (flag & 0b100) === 0b100;
            const isHeal = d.Type === pb.EDamageType?.Heal;
            const isDead = !!d.IsDead;
            const isLucky = !!luckyValue;
            const hpLessen = toNum(d.HpLessenValue ?? 0);
            const damageElement = getDamageElement(d.Property);
            const damageSource = d.DamageSource ?? 0;

            if (targetIsPlayer) {
                if (isHeal) {
                    userDataManager.addHealing(
                        attackerIsPlayer ? attackerUuid.toNumber() : 0,
                        skillId, damageElement, Number(damage), isCrit, isLucky, isCauseLucky, targetUuid.toNumber()
                    );
                } else {
                    userDataManager.addTakenDamage(targetUuid.toNumber(), Number(damage), isDead);
                }
                if (isDead) userDataManager.setAttrKV(targetUuid.toNumber(), 'hp', 0);
            } else {
                if (!isHeal && attackerIsPlayer) {
                    userDataManager.addDamage(
                        attackerUuid.toNumber(), skillId, damageElement, Number(damage),
                        isCrit, isLucky, isCauseLucky, hpLessen, targetUuid.toNumber()
                    );
                }
                if (isDead) userDataManager.deleteEnemyData(targetUuid.toNumber());
            }

            const extra = [];
            if (isCrit) extra.push('Crit');
            if (isLucky) extra.push('Lucky');
            if (isCauseLucky) extra.push('CauseLucky');
            if (!extra.length) extra.push('Normal');

            const actionType = isHeal ? 'HEAL' : 'DMG';
            let infoStr = 'SRC: ';

            if (attackerIsPlayer) {
                const attacker = userDataManager.getUser(attackerUuid.toNumber());
                if (attacker.name) infoStr += attacker.name;
                infoStr += `#${attackerUuid.toString()}(player)`;
            } else {
                const n = userDataManager.enemyCache.name.get(attackerUuid.toNumber());
                if (n) infoStr += n;
                infoStr += `#${attackerUuid.toString()}(enemy)`;
            }

            let targetName = '';
            if (targetIsPlayer) {
                const tgt = userDataManager.getUser(targetUuid.toNumber());
                if (tgt.name) targetName += tgt.name;
                targetName += `#${targetUuid.toString()}(player)`;
            } else {
                const n = userDataManager.enemyCache.name.get(targetUuid.toNumber());
                if (n) targetName += n;
                targetName += `#${targetUuid.toString()}(enemy)`;
            }

            infoStr += ` TGT: ${targetName}`;
            const log = `[${actionType}] DS: ${getDamageSource(damageSource)} ${infoStr} ID: ${skillId} VAL: ${damage} HPLSN: ${hpLessen} ELEM: ${damageElement.slice(-1)} EXT: ${extra.join('|')}`;
            userDataManager.addLog(log);
        }
    }

    #processSyncNearDeltaInfo(payload) {
        const m = decodeSafely(
            pb,
            ['SyncNearDeltaInfo', 'Notify.SyncNearDeltaInfo', 'NearDeltaInfo', 'NotifySyncNearDeltaInfo'],
            payload, { tag: 'SyncNearDeltaInfo' }
        );
        if (!m?.DeltaInfos) return;
        for (const d of m.DeltaInfos) this.#processAoiSyncDelta(d);
    }

    #processSyncToMeDeltaInfo(payload) {
        const m = decodeSafely(
            pb,
            ['SyncToMeDeltaInfo', 'Notify.SyncToMeDeltaInfo', 'ToMeDeltaInfo', 'NotifySyncToMeDeltaInfo'],
            payload, { tag: 'SyncToMeDeltaInfo' }
        );
        if (!m) return;

        const toMe = m.DeltaInfo;
        let uuid = toMe?.Uuid;
        if (!uuid) return;

        try {
            uuid = Long.isLong(uuid) ? uuid.toUnsigned() : Long.fromValue(uuid).toUnsigned();
        } catch { return; }

        // on maintient les deux pour compat:
        instanceTracker.setPlayerUuid(uuid, { debounceMs: 0 });
        this.#currentUserUuid = uuid;

        const base = toMe?.BaseDelta;
        if (base) this.#processAoiSyncDelta(base);
    }

    /* ---------- Container data ---------- */
    #processSyncContainerData(payload) {
        try {
            const m = decodeSafely(
                pb,
                ['SyncContainerData', 'Notify.SyncContainerData'],
                payload,
                { tag: 'SyncContainerData' }
            );
            if (!m?.VData) return;

            const vData = m.VData;

            // ----- INSPECTEUR (optionnel) -----
            if (process.env.DEBUG_INSTANCE_KEYS === '1') {
                const snap = dumpSnapshot('./_vdata_dumps', 'after_SyncContainerData', vData, logger);
                const currInteresting = snap?.interesting ?? findInterestingFields(vData);
                try {
                    globalThis.__LAST_INTERESTING__ = globalThis.__LAST_INTERESTING__ ?? [];
                    const { added, removed, changed } =
                        diffInteresting(globalThis.__LAST_INTERESTING__, currInteresting);

                    if (added.length || removed.length || changed.length) {
                        logger.info('[INSPECT] VData interesting diff', {
                            added: added.slice(0, 50),
                            removed: removed.slice(0, 50),
                            changed: changed.slice(0, 50),
                        });
                    } else {
                        logger.info('[INSPECT] VData interesting diff: (no changes)');
                    }

                    globalThis.__LAST_INTERESTING__ = currInteresting;
                } catch (e) {
                    logger.warn('[INSPECT] diff failed', { err: e?.message });
                }
            }

            if (process.env.DEBUG_INSTANCE === '1' && !globalThis.__VDataKeysLogged) {
                globalThis.__VDataKeysLogged = true;
                try {
                    logger.debug(`[INSTANCE] VData keys: ${Object.keys(vData).join(', ')}`);
                } catch { }
            }

            // ---- DÉTECTION D’INSTANCE (précise via InstanceTracker) ----
            // updateFromVData déclenche updateFromSceneData si vData.SceneData est présent.
            instanceTracker.updateFromVData(vData);

            // ---- MISE À JOUR JOUEUR ----
            const charId = vData?.CharId;
            if (!charId) return;
            const playerUid = toNum(charId);

            if (vData.RoleLevel?.Level) userDataManager.setAttrKV(playerUid, 'level', vData.RoleLevel.Level);
            if (vData.Attr?.CurHp) userDataManager.setAttrKV(playerUid, 'hp', toNum(vData.Attr.CurHp));
            if (vData.Attr?.MaxHp) userDataManager.setAttrKV(playerUid, 'max_hp', toNum(vData.Attr.MaxHp));

            const charBase = vData.CharBase;
            if (charBase?.Name) userDataManager.setName(playerUid, charBase.Name);
            if (charBase?.FightPoint) userDataManager.setFightPoint(playerUid, charBase.FightPoint);

            const prof = vData.ProfessionList;
            if (prof?.CurProfessionId) {
                userDataManager.setProfession(playerUid, getProfessionNameFromId(prof.CurProfessionId));
            }
        } catch (err) {
            try { fs.writeFileSync('./SyncContainerData.dat', payload); } catch { }
            logger.warn(
                `Failed to decode SyncContainerData for player ${this.#currentUserUuid.shiftRight(16)}. Please report to developer`
            );
            throw err;
        }
    }

    #processSyncContainerDirtyData(payload) {
        if (this.#currentUserUuid.isZero()) return;

        const m = decodeSafely(pb,
            ['SyncContainerDirtyData', 'Notify.SyncContainerDirtyData'],
            payload, { tag: 'SyncContainerDirtyData' }
        );
        const buf = m?.VData?.Buffer;
        if (!buf) return;

        // ===== Fallback best-effort : sonder une mini-structure scene/instance dans le blob =====
        try {
            const probeReader = new BinaryReader(Buffer.from(buf));
            if (doesStreamHaveIdentifier(probeReader)) {
                const blob = probeReader.readRemaining();
                const maybe = decodeSafely(pb,
                    ['SceneInfo', 'MapInfo', 'LevelInfo', 'UserVData', 'VData'],
                    blob, { tag: 'DirtyData-Probe' }
                );
                const idProbe = localExtractSceneLikeId(maybe);
                if (Number.isFinite(idProbe)) {
                    instanceTracker.probeDirtyBlob({ idProbe: Number(idProbe) });
                }
            }
        } catch { /* soft-fail */ }

        const r = new BinaryReader(Buffer.from(buf));
        if (!doesStreamHaveIdentifier(r)) return;

        let fieldIndex = r.readUInt32LE();
        r.readInt32();

        switch (fieldIndex) {
            case 2: { // CharBase
                if (!doesStreamHaveIdentifier(r)) break;
                fieldIndex = r.readUInt32LE(); r.readInt32();
                if (fieldIndex === 5) { // Name
                    const name = streamReadString(r);
                    if (name) userDataManager.setName(this.#currentUserUuid.shiftRight(16).toNumber(), name);
                } else if (fieldIndex === 35) { // FightPoint
                    const fp = r.readUInt32LE(); r.readInt32();
                    userDataManager.setFightPoint(this.#currentUserUuid.shiftRight(16).toNumber(), fp);
                }
                break;
            }
            case 16: { // UserFightAttr
                if (!doesStreamHaveIdentifier(r)) break;
                fieldIndex = r.readUInt32LE(); r.readInt32();
                if (fieldIndex === 1) {
                    const curHp = r.readUInt32LE();
                    userDataManager.setAttrKV(this.#currentUserUuid.shiftRight(16).toNumber(), 'hp', curHp);
                } else if (fieldIndex === 2) {
                    const maxHp = r.readUInt32LE();
                    userDataManager.setAttrKV(this.#currentUserUuid.shiftRight(16).toNumber(), 'max_hp', maxHp);
                }
                break;
            }
            case 61: { // ProfessionList
                if (!doesStreamHaveIdentifier(r)) break;
                fieldIndex = r.readUInt32LE(); r.readInt32();
                if (fieldIndex === 1) {
                    const curProfessionId = r.readUInt32LE(); r.readInt32();
                    if (curProfessionId) {
                        userDataManager.setProfession(
                            this.#currentUserUuid.shiftRight(16).toNumber(),
                            getProfessionNameFromId(curProfessionId),
                        );
                    }
                }
                break;
            }
            default: break;
        }
    }

    /* ---------- Entities ---------- */
    #processSyncNearEntities(payload) {
        const m = decodeSafely(pb,
            ['SyncNearEntities', 'Notify.SyncNearEntities', 'NearEntitiesSync', 'NotifySyncNearEntities'],
            payload, { tag: 'SyncNearEntities' }
        );
        if (!m) return;

        const appear = m.Appear ?? [];
        const disappear = m.Disappear ?? [];

        const disappearCount = disappear.length || 0;
        // Heuristique wipe massive (approx. locale)
        if (disappearCount >= Math.max(10, Math.floor(0.8 * (appear.length + disappearCount)))) {
            instanceTracker.onAoiWipe({ disappearCount });
        }

        if (!this.#currentUserUuid.isZero()) {
            const meAppeared = appear.some((ent) => ent?.Uuid && ent.Uuid.eq(this.#currentUserUuid));
            if (meAppeared) {
                instanceTracker.onSelfAppearedInAoi({ uuid: this.#currentUserUuid.toString() });
            }
        }

        const populationDelta = (appear.length || 0) - disappearCount;
        instanceTracker.onPopulationDelta(populationDelta);

        // Attributs
        for (const entity of appear) {
            const entUuid = entity?.Uuid;
            if (!entUuid) continue;

            const entUid = entUuid.shiftRight(16).toNumber();
            const attrs = entity?.Attrs?.Attrs;

            const guessPlayer = isUuidPlayer(entUuid);
            const guessMonster = isUuidMonster(entUuid);
            const entType = entity?.EntType;
            const enumType = pb.EEntityType || {};

            const isMonster = (entType === enumType.EntMonster) || (!entType && guessMonster);
            const isChar = (entType === enumType.EntChar) || (!entType && guessPlayer);

            if (attrs?.length) {
                if (isMonster) this.#processEnemyAttrs(entUid, attrs);
                else if (isChar) this.#processPlayerAttrs(entUid, attrs);
                else {
                    if (guessMonster) this.#processEnemyAttrs(entUid, attrs);
                    else if (guessPlayer) this.#processPlayerAttrs(entUid, attrs);
                }
            }
        }

        if (!this.#currentUserUuid.isZero() && Array.isArray(disappear)) {
            const meGone = disappear.some((ent) => ent?.Uuid && ent.Uuid.eq(this.#currentUserUuid));
            if (meGone) instanceTracker.onSelfDisappearedFromAoi({ uuid: this.#currentUserUuid.toString() });
        }
    }

    /* ---------- Attributes parsing ---------- */
    #processPlayerAttrs(playerUid, attrs) {
        for (const a of attrs) {
            const id = a?.Id; const raw = a?.RawData;
            if (!id || !raw) continue;
            const r = pbjs.Reader.create(raw);
            switch (id) {
                case AttrType.AttrName: userDataManager.setName(playerUid, r.string()); break;
                case AttrType.AttrProfessionId: userDataManager.setProfession(playerUid, getProfessionNameFromId(r.int32())); break;
                case AttrType.AttrFightPoint: userDataManager.setFightPoint(playerUid, r.int32()); break;
                case AttrType.AttrLevel: userDataManager.setAttrKV(playerUid, 'level', r.int32()); break;
                case AttrType.AttrRankLevel: userDataManager.setAttrKV(playerUid, 'rank_level', r.int32()); break;
                case AttrType.AttrCri: userDataManager.setAttrKV(playerUid, 'cri', r.int32()); break;
                case AttrType.AttrLucky: userDataManager.setAttrKV(playerUid, 'lucky', r.int32()); break;
                case AttrType.AttrHp: userDataManager.setAttrKV(playerUid, 'hp', r.int32()); break;
                case AttrType.AttrMaxHp: userDataManager.setAttrKV(playerUid, 'max_hp', r.int32()); break;
                case AttrType.AttrElementFlag: userDataManager.setAttrKV(playerUid, 'element_flag', r.int32()); break;
                case AttrType.AttrEnergyFlag: userDataManager.setAttrKV(playerUid, 'energy_flag', r.int32()); break;
                case AttrType.AttrReductionLevel: userDataManager.setAttrKV(playerUid, 'reduction_level', r.int32()); break;
                default: break;
            }
        }
    }

    #processEnemyAttrs(enemyUid, attrs) {
        for (const a of attrs) {
            const id = a?.Id; const raw = a?.RawData;
            if (!id || !raw) continue;
            const r = pbjs.Reader.create(raw);
            switch (id) {
                case AttrType.AttrName: {
                    const name = r.string();
                    userDataManager.enemyCache.name.set(enemyUid, name);
                    logger.info(`Found monster name ${name} for id ${enemyUid}`);
                    break;
                }
                case AttrType.AttrId: {
                    const attrId = r.int32();
                    const name = monsterNames[attrId];
                    if (name) {
                        logger.info(`Found monster name ${name} for id ${enemyUid}`);
                        userDataManager.enemyCache.name.set(enemyUid, name);
                    }
                    break;
                }
                case AttrType.AttrHp: {
                    userDataManager.enemyCache.hp.set(enemyUid, r.int32());
                    break;
                }
                case AttrType.AttrMaxHp: {
                    userDataManager.enemyCache.maxHp.set(enemyUid, r.int32());
                    break;
                }
                default: break;
            }
        }
    }

    /* ---------- Dispatcher ---------- */
    #processNotifyMsg(reader, isZstd) {
        const serviceUuid = reader.readUInt64();
        reader.readUInt32(); // stubId
        const methodId = reader.readUInt32();

        if (serviceUuid !== SERVICE_UUID_NOTIFY) {
            logger.debug(`Skipping NotifyMsg with serviceId ${serviceUuid}`);
            return;
        }

        let payload = reader.readRemaining();
        payload = isZstd ? this.#maybeDecompress(payload, { zstdFlag: true }) : payload;

        if (!payload?.length) {
            logger.warn('Notify payload empty', { methodId });
            return;
        }

        switch (methodId) {
            case NotifyMethod.SyncNearEntities: this.#processSyncNearEntities(payload); break;
            case NotifyMethod.SyncContainerData: this.#processSyncContainerData(payload); break;
            case NotifyMethod.SyncContainerDirtyData: this.#processSyncContainerDirtyData(payload); break;
            case NotifyMethod.SyncToMeDeltaInfo: this.#processSyncToMeDeltaInfo(payload); break;
            case NotifyMethod.SyncNearDeltaInfo: this.#processSyncNearDeltaInfo(payload); break;
            default: logger.debug(`Skipping NotifyMsg with methodId ${methodId}`); break;
        }
    }

    #processReturnMsg() {
        logger.debug('Unimplemented processing return');
    }

    /* ---------- Entrées publiques ---------- */
    processPacket(packets) {
        try {
            const reader = new BinaryReader(packets);
            const MIN = 6;
            const MAX = 1024 * 1024;

            while (reader.remaining() >= MIN) {
                const packetSize = reader.peekUInt32();
                if (packetSize < MIN || packetSize > MAX) {
                    logger.warn(`Invalid packet length detected: ${packetSize}. Discarding corrupt buffer.`);
                    return;
                }
                if (reader.remaining() < packetSize) return;

                const packetReader = new BinaryReader(reader.readBytes(packetSize));
                packetReader.readUInt32();
                const packetType = packetReader.readUInt16();
                const isZstd = (packetType & 0x8000) !== 0;
                const msgTypeId = packetType & 0x7fff;

                switch (msgTypeId) {
                    case MessageType.Notify: this.#processNotifyMsg(packetReader, isZstd); break;
                    case MessageType.Return: this.#processReturnMsg(packetReader, isZstd); break;
                    case MessageType.FrameDown: {
                        packetReader.readUInt32(); // serverSequenceId
                        if (packetReader.remaining() === 0) break;
                        let nested = packetReader.readRemaining();
                        nested = isZstd ? this.#maybeDecompress(nested, { zstdFlag: true }) : nested;
                        this.processPacket(nested);
                        break;
                    }
                    default: /* ignore */ break;
                }
            }
        } catch (e) {
            logger.error(`Fatal error while parsing packet data for player ${this.#currentUserUuid.shiftRight(16)}.\nErr: ${e.stack}`);
        }
    }

    processDataChunk(chunk) {
        if (!chunk?.length) return;
        this.#internalBuffer = Buffer.concat([this.#internalBuffer, chunk]);
        this.#parseBuffer();
    }

    #parseBuffer() {
        const MIN = 6;
        const MAX = 1024 * 1024;

        while (this.#internalBuffer.length >= 4) {
            const temp = new BinaryReader(this.#internalBuffer);
            const hasHeader = doesStreamHaveIdentifier(temp);
            if (!hasHeader) {
                logger.warn(`Invalid packet header: ${this.#internalBuffer.readUInt32LE(0)}. Advancing to next chunk.`);
                this.#internalBuffer = this.#internalBuffer.subarray(4);
                continue;
            }
            const packetSize = this.#internalBuffer.readUInt32LE(0);
            if (packetSize < MIN || packetSize > MAX) {
                logger.warn(`Invalid packet length detected: ${packetSize}. Clearing internal buffer.`);
                this.#internalBuffer = Buffer.alloc(0);
                break;
            }
            if (this.#internalBuffer.length < packetSize) break;

            const packetData = this.#internalBuffer.subarray(0, packetSize);
            this.#internalBuffer = this.#internalBuffer.subarray(packetSize);
            this.#processSinglePacket(packetData);
        }
    }

    #processSinglePacket(packetBuffer) {
        try {
            const r = new BinaryReader(packetBuffer);
            r.readUInt32();
            const type = r.readUInt16();
            const isZstd = (type & 0x8000) !== 0;
            const msgTypeId = type & 0x7fff;

            switch (msgTypeId) {
                case MessageType.Notify: this.#processNotifyMsg(r, isZstd); break;
                case MessageType.Return: this.#processReturnMsg(r, isZstd); break;
                case MessageType.FrameDown: {
                    r.readUInt32(); // serverSequenceId
                    if (r.remaining() === 0) break;
                    let nested = r.readRemaining();
                    nested = isZstd ? this.#maybeDecompress(nested, { zstdFlag: true }) : nested;
                    this.processDataChunk(nested);
                    break;
                }
                default: /* ignore */ break;
            }
        } catch {
            // parsing guard silencieux
        }
    }
}
