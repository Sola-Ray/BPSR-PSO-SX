// ESM, Node 18+

import path from 'path';
import { fileURLToPath } from 'url';
import {
    isFiniteNumber,
    safeReadJSON,
    u64ToString,
    deriveSceneId,
    deriveLineId,
} from './utils/instance-utils.js';
import { dumpSnapshot, diffInteresting } from '../debog/DebugVDataInspector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEBUG_UUID = process.env.DEBUG_PLAYER_UUID === '1';

export class InstanceTracker {
    /**
     * @param {{logger?:any, userDataManager?:any, debounceMs?:number, mapNamesPath?:string}} opts
     */
    constructor(opts = {}) {
        const {
            logger,
            userDataManager,
            debounceMs = 0,
            mapNamesPath,
        } = opts;

        this.logger = logger;
        this.udm = userDataManager;
        this.debounceMs = Number(debounceMs) || 0;

        // Debug inspector
        this._lastInteresting = null;
        this._inspectOutDir = './debug/vdata';

        // état public minimal
        this.currentMapId = null;
        this.currentMapName = null;
        this.currentSceneId = null;   // scène courante (id autoritaire)
        this.currentLineId = null;    // canal/line pour la scène courante

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

        // Table des noms de map
        const defaultMapUrl = new URL('../tables/map_names.json', import.meta.url);
        const table = safeReadJSON(mapNamesPath || defaultMapUrl, this.logger);
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
            lineId: null,
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

    /* ───────── mutations / logs ───────── */

    /**
     * Met à jour l'UUID joueur et en déduit un UID court (>>16).
     * Débouncé si demandé. Déclenche un bump si changement réel.
     */
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

        if (DEBUG_UUID) {
            try {
                this.logger?.debug?.('[DEBUG_UUID] player-uuid-changed (pre-bump)', {
                    seq: this._instanceSeq + 1,
                    prevUuid: prevUuid ? prevUuid.toString() : null,
                    newUuid: uuid.toString(),
                    newUid,
                    debounceMs,
                    sinceLastChangeMs: Date.now() - this._lastChangeTs,
                    mapId: this.currentMapId,
                    sceneId: this.currentSceneId,
                    sceneKey: this.getSceneKey(),
                });
            } catch { /* noop */ }
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

    bump(reason, extra = {}) {
        const now = Date.now();
        if (this.debounceMs > 0 && now - this._lastChangeTs < this.debounceMs) return;

        this._instanceSeq += 1;
        this._lastChangeTs = now;

        const toId = extra?.to ?? this.currentMapId ?? '??';
        const msg = `[INSTANCE] #${this._instanceSeq} - (id=${toId}) - ${reason}`;
        this.logger?.info?.(msg, extra);
        this.udm?.addLog?.(msg);

        if (!this._shouldTriggerInstance(reason)) return;

        try {
            this.udm?.enemyCache?.name?.clear?.();
            this.udm?.enemyCache?.hp?.clear?.();
            this.udm?.enemyCache?.maxHp?.clear?.();
            this.udm?.clearLiveLogs?.();
        } catch { /* noop */ }

        this.udm?.onInstanceChanged?.(this._instanceSeq, reason, { ...extra });
    }

    /* ───────── scène: staging/commit ───────── */

    _commitPendingScene(via = 'commit') {
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

        // reset line à l'entrée de la nouvelle scène
        this.currentLineId = this._scene?.lineId ?? null;

        this.bump('scene-id-changed', {
            from: prevSceneId ?? srcSceneId ?? null,
            to: this.currentSceneId,
            via,
        });
    }

    updateFromSceneData(sceneData) {
        if (!sceneData || typeof sceneData !== 'object') return;

        const srcSceneId = isFiniteNumber(sceneData?.LastSceneData?.SceneId)
            ? Number(sceneData.LastSceneData.SceneId)
            : null;

        const levelMapId = isFiniteNumber(sceneData.LevelMapId) ? Number(sceneData.LevelMapId) : null;
        const nextSceneId = levelMapId ?? null;
        const nextLineId = isFiniteNumber(sceneData.LineId) ? Number(sceneData.LineId) : null;

        const next = {
            dungeonGuid: u64ToString(sceneData.DungeonGuid),
            levelUuid: u64ToString(sceneData.LevelUuid),
            sceneGuid: u64ToString(sceneData.SceneGuid),
            recordId: u64ToString(sceneData.RecordId),
            mapId: null,
            levelMapId,
            lastSceneId: srcSceneId,
            sceneId: nextSceneId,
            lineId: nextLineId,
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

        const infoMsg = `[INSTANCE] staged scene (${kind})`;
        this.logger?.info?.(infoMsg, {
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
            stagedLineId: nextLineId,
        });
        this.udm?.addLog?.(infoMsg);
    }

    updateFromVData(vData) {
        if (!vData) return;

        const prevInteresting = this._lastInteresting;

        if (vData.SceneData) this.updateFromSceneData(vData.SceneData);

        const derivedSceneId = deriveSceneId(vData);
        const derivedLineId = deriveLineId(vData);

        // 1) Changement de scène (map)
        if (derivedSceneId != null && derivedSceneId !== this.currentSceneId) {
            if (this._pendingScene) {
                this._commitPendingScene('map-or-dungeon-changed');
            } else {
                const prev = this.currentSceneId;
                this.currentSceneId = derivedSceneId;
                // reset line sur changement de scène
                this.currentLineId = this._scene?.lineId ?? derivedLineId ?? null;
                this.bump('scene-id-changed', { from: prev, to: this.currentSceneId, via: 'derived' });
            }
        } else {
            // 2) Même scène → détecter changement de LineId
            const nextLine = this._scene?.lineId ?? derivedLineId ?? null;
            if (nextLine != null) {
                const prevLine = this.currentLineId;
                if (prevLine == null) {
                    this.currentLineId = nextLine; // init
                } else if (prevLine !== nextLine) {
                    const sceneId = this.currentSceneId;
                    this.currentLineId = nextLine;
                    // Déclenche un évènement d’instance, comme un scene change
                    this.bump('line-id-changed', {
                        sceneId,
                        fromLine: prevLine,
                        toLine: nextLine,
                        to: this.currentMapId,
                        mapName: this.currentMapName,
                    });
                }
            }
        }

        // Debug: dumps/diff VData
        try {
            const dump = dumpSnapshot(this._inspectOutDir, 'vdata', vData, this.logger);
            if (dump?.interesting) {
                if (prevInteresting) {
                    const { /* added, removed, */ changed } = diffInteresting(prevInteresting, dump.interesting);
                    // Log explicite si LineId flip détecté dans le diff (même scène)
                    const prevSceneId = prevInteresting.find(
                        (x) => x.key.endsWith('SceneData.LevelMapId') || x.key.endsWith('LevelMapId')
                    )?.value;
                    const currSceneId = dump.interesting.find(
                        (x) => x.key.endsWith('SceneData.LevelMapId') || x.key.endsWith('LevelMapId')
                    )?.value;

                    const prevLine = prevInteresting.find((x) => x.key === 'SceneData.LineId')?.value;
                    const currLine = dump.interesting.find((x) => x.key === 'SceneData.LineId')?.value;

                    if (
                        prevSceneId != null &&
                        currSceneId != null &&
                        prevSceneId === currSceneId &&
                        prevLine != null &&
                        currLine != null &&
                        prevLine !== currLine
                    ) {
                        this.logger?.info?.('[LINE-DETECT] LineId changed (diff)', {
                            sceneId: currSceneId, from: prevLine, to: currLine,
                        });
                    }
                    // changed peut être exploité au besoin
                    void changed;
                }
                this._lastInteresting = dump.interesting;
            }
        } catch (e) {
            this.logger?.warn?.('[VDATA DEBUG] failed', { err: e?.message });
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
        // On déclenche aussi sur changement de ligne / de scène
        return reason === 'scene-id-changed' || reason === 'line-id-changed';
    }
}
