// src/services/InstanceTracker.js
// ESM, Node 18+

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ───────────────────────── helpers & const ───────────────────────── */

const MAX_INSTANCE_ID = 10_000_000;

const isFiniteNum = (v) => Number.isFinite(Number(v));

const safeReadJSON = (p, logger) => {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        logger?.warn?.('JSON load failed', { path: p, err: e?.message });
        return null;
    }
};

const isPlausibleInstanceId = (id) =>
    Number.isFinite(id) && id > 0 && id <= MAX_INSTANCE_ID;

/** high/low → u64 string (ou toString fallback) */
const u64ToString = (u) => {
    if (!u) return null;
    try {
        if (typeof u === 'object' && u.high != null && u.low != null) {
            const hi = BigInt(u.high >>> 0);
            const lo = BigInt(u.low >>> 0);
            return ((hi << 32n) | lo).toString();
        }
        return String(u);
    } catch {
        return String(u);
    }
};

/* ───────────────────────── class ───────────────────────── */

export class InstanceTracker {
    /**
     * @param {{logger?:any, userDataManager?:any, debounceMs?:number, mapNamesPath?:string}} opts
     */
    constructor(opts = {}) {
        const {
            logger = undefined,
            userDataManager = undefined,
            debounceMs = 0,
            mapNamesPath,
        } = opts;

        this.logger = logger;
        this.udm = userDataManager;
        this.debounceMs = Number(debounceMs) || 0;

        // état public/minimal
        this.currentMapId = null;
        this.currentMapName = null;

        // scène courante (chez nous = id de scène autoritaire)
        this.currentSceneId = null;

        this.currentPlayerUuid = null;
        this.currentPlayerUid = null;
        this._lastUidChangeAt = 0;

        this._firstInstanceLocked = false;

        // état interne
        this._instanceSeq = 0;
        this._lastChangeTs = Date.now();
        this._lastAoiPopulation = 0;
        this._lastAoiWipeTs = 0;
        this._lastSelfAppearedTs = 0;

        // staging de scène: { srcSceneId, dstSceneId, nextSceneId }
        this._pendingScene = null;

        // table des noms de map
        const defaultMapPath = path.join(__dirname, '../tables/map_names.json');
        const table = safeReadJSON(mapNamesPath || defaultMapPath, this.logger);
        this.mapNamesTable = table ?? {};
        this.logger?.info?.(
            table
                ? `[INSTANCE] map_names.json loaded (${Object.keys(table).length} entries)`
                : '[INSTANCE] map_names.json not found - using id-only names'
        );

        // État brut pour SceneData (debug/traçage)
        this._scene = {
            dungeonGuid: null,
            levelUuid: null,
            sceneGuid: null,
            recordId: null,
            mapId: null,
            levelMapId: null,
            lastSceneId: null,
            sceneId: null,
        };
    }

    /* ───────── getters utilitaires ───────── */

    getSceneId() {
        return this.currentSceneId;
    }

    /** Clé “globale” d’instance : GUID/UUID > sceneId > mapId */
    getSceneKey() {
        return (
            this._scene.levelUuid ||
            this._scene.sceneGuid ||
            this._scene.recordId ||
            (this.currentSceneId != null ? `scene:${this.currentSceneId}` : null) ||
            (this.currentMapId != null ? `map:${this.currentMapId}` : 'unknown')
        );
    }

    static _deriveSceneIdFromVData(vData) {
        const id = Number.isFinite(Number(vData?.SceneData?.LevelMapId))
            ? Number(vData.SceneData.LevelMapId)
            : null;
        return id;
    }

    /* ───────── mutations / logs ───────── */

    setPlayerUuid(newUuidLong, { debounceMs = 0 } = {}) {
        const uuid = newUuidLong?.toUnsigned ? newUuidLong.toUnsigned() : newUuidLong;
        if (!uuid) return false;

        const newUid =
            typeof uuid?.shiftRightUnsigned === 'function'
                ? Number(uuid.shiftRightUnsigned(16))
                : Number(uuid.shru?.(16));

        if (this.currentPlayerUid != null && this.currentPlayerUid === newUid) return false;

        const now = Date.now();
        if (debounceMs > 0 && now - this._lastUidChangeAt < debounceMs) return false;

        const prevUuid = this.currentPlayerUuid;
        this.currentPlayerUuid = uuid;
        this.currentPlayerUid = newUid;
        this._lastUidChangeAt = now;

        if (process?.env?.DEBUG_PLAYER_UUID === '1') {
            try {
                this.logger?.debug?.('[DEBUG_UUID] player-uuid-changed (pre-bump)', {seq: this._instanceSeq + 1,
                    prevUuid: prevUuid ? prevUuid.toString() : null,
                    newUuid: uuid.toString(),
                    newUid,
                    debounceMs,
                    sinceLastChangeMs: Date.now() - this._lastChangeTs,
                    mapId: this.currentMapId,
                    sceneId: this.currentSceneId,
                    sceneKey: this.getSceneKey(),
                });
            } catch { }
        }
        this.bump('player-uuid-changed', {
            prevUuid: prevUuid ? prevUuid.toString() : null,
            newUuid: uuid.toString(),
            uid: String(newUid),
            mapName: this.currentMapName,
            to: this.currentMapId,
        });
        return true;
    }

    resolveMapName(vData, mapId) {
        const name =
            vData?.SceneName ??
            vData?.MapName ??
            vData?.LevelName ??
            vData?.SceneInfo?.Name ??
            vData?.SceneInfo?.InstanceName ??
            vData?.LevelInfo?.Name;

        if (typeof name === 'string') return name;
        if (mapId == null) return 'Unknown Map';

        return this.mapNamesTable[String(mapId)] ?? `Map ${mapId}`;
    }

    _info(msg, extra = {}) {
        this.logger?.info?.(msg, extra);
        this.udm?.addLog?.(msg);
    }

    bump(reason, extra = {}) {
        const now = Date.now();
        if (this.debounceMs > 0 && now - this._lastChangeTs < this.debounceMs) return;

        this._instanceSeq += 1;
        this._lastChangeTs = now;

        const msg = `[INSTANCE] #${this._instanceSeq} - (id=${extra?.to ?? this.currentMapId ?? '??'}) - ${reason}`;
        this.logger?.info?.(msg, extra);
        this.udm?.addLog?.(msg);

        const shouldTrigger = this._shouldTriggerInstance(reason);

        if (!shouldTrigger) {
            return;
        }

        try {
            this.udm?.enemyCache?.name?.clear?.();
            this.udm?.enemyCache?.hp?.clear?.();
            this.udm?.enemyCache?.maxHp?.clear?.();
            this.udm?.clearLiveLogs?.();
        } catch { }

        this.udm?.onInstanceChanged?.(this._instanceSeq, reason, { ...extra });
    }

    /* ───────── scène: staging/commit ───────── */

    _commitPendingScene(reason = 'commit') {
        const staged = this._pendingScene;
        if (!staged) return;

        const { srcSceneId, nextSceneId } = staged;
        if (nextSceneId == null || nextSceneId === this.currentSceneId) {
            this._pendingScene = null;
            return;
        }

        const prevSceneId = this.currentSceneId;
        this.currentSceneId = nextSceneId;
        this._pendingScene = null;

        this.bump('scene-id-changed', {
            from: prevSceneId ?? srcSceneId ?? null,
            to: this.currentSceneId,
            via: reason,
        });
    }

    updateFromSceneData(sceneData) {
        if (!sceneData || typeof sceneData !== 'object') return;

        const srcSceneId = isFiniteNum(sceneData?.LastSceneData?.SceneId)
            ? Number(sceneData.LastSceneData.SceneId)
            : null;

        const levelMapId = isFiniteNum(sceneData.LevelMapId) ? Number(sceneData.LevelMapId) : null;
        const nextSceneId = levelMapId ?? null;

        const next = {
            dungeonGuid: u64ToString(sceneData.DungeonGuid),
            levelUuid: u64ToString(sceneData.LevelUuid),
            sceneGuid: u64ToString(sceneData.SceneGuid),
            recordId: u64ToString(sceneData.RecordId),
            mapId: null,
            levelMapId,
            lastSceneId: srcSceneId,
            sceneId: nextSceneId,
        };

        const prev = this._scene || {};
        const changed = Object.keys(next).filter((k) => next[k] !== prev[k]);
        if (changed.length === 0) return;

        this._scene = next;
        this._pendingScene = { srcSceneId, dstSceneId: nextSceneId, nextSceneId, levelMapId };

        this.logger?.debug?.('[INSTANCE] staged scene via SceneData', this._pendingScene);

        const isInstanced =
            !!next.dungeonGuid || !!next.levelUuid || !!next.sceneGuid || !!next.recordId;
        const kind = isInstanced ? 'dungeonOrRaid' : 'openWorld';
        const key =
            next.levelUuid ||
            next.sceneGuid ||
            next.recordId ||
            (nextSceneId != null ? `scene:${nextSceneId}` : 'unknown');

        this._info(`[INSTANCE] staged scene (${kind})`, {
            reasonKeys: changed,
            key,
            kind,
            dungeonGuid: next.dungeonGuid,
            levelUuid: next.levelUuid,
            sceneGuid: next.sceneGuid,
            recordId: next.recordId,
            mapId: next.mapId,
            levelMapId: next.levelMapId,
            srcSceneId,
            stagedSceneId: nextSceneId,
        });
    }

    updateFromVData(vData) {
        if (!vData) return;

        if (vData.SceneData) this.updateFromSceneData(vData.SceneData);

        const derivedSceneId = InstanceTracker._deriveSceneIdFromVData(vData);
        if (derivedSceneId != null && derivedSceneId !== this.currentSceneId) {
            if (this._pendingScene) {
                this._commitPendingScene('map-or-dungeon-changed');
            } else {
                const prev = this.currentSceneId;
                this.currentSceneId = derivedSceneId;
                this.bump('scene-id-changed', { from: prev, to: this.currentSceneId, via: 'derived' });
            }
        }
    }

    /* ───────── AOI hooks ───────── */

    onAoiWipe({ disappearCount }) {
        this._lastAoiWipeTs = Date.now();
        this.bump('aoi-wipe', {
            disappearCount,
            lastAoiPopulation: this._lastAoiPopulation,
            mapName: this.currentMapName,
            to: this.currentMapId,
        });
        this._commitPendingScene('aoi-wipe');
    }

    onSelfAppearedInAoi({ uuid }) {
        this._lastSelfAppearedTs = Date.now();
        this.bump('self-appeared-in-aoi', { uuid });

        this._commitPendingScene('self-appeared-in-aoi');

        if (Date.now() - this._lastAoiWipeTs < 3000) {
            this.bump('entered-sub-instance', {
                mapId: this.currentMapId,
                mapName: this.currentMapName,
            });
        }
    }

    onSelfDisappearedFromAoi({ uuid }) {
        this.bump('self-disappeared-from-aoi', { uuid });
    }

    onPopulationDelta(delta) {
        if (delta !== 0) this._lastAoiPopulation = Math.max(0, this._lastAoiPopulation + delta);
    }

    _shouldTriggerInstance(reason) {
        if (!this._firstInstanceLocked) {
            if (reason === 'player-uuid-changed') {
                this._firstInstanceLocked = true;
                return true;
            }
            return false;
        }
        return reason === 'scene-id-changed';
    }
}
