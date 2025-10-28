// src/debug/DebugVDataInspector.js
// ESM, Node 18+

import fs from 'fs';
import path from 'path';

// élargit la détection aux Line/Guid/Uuid/Record
const ID_KEY_RX =
    /(scene(Id)?|map(Id)?|level(Id)?|area(Id)?|zone(Id)?|dungeon(Id)?|raid(Id)?|instance(Id)?|stage(Id)?|room(Id)?|copy(Id)?|chapter(Id)?|line(Id)?|guid|uuid|record(Id)?)/i;

const NAME_KEY_SET = new Set([
    'SceneName',
    'MapName',
    'LevelName',
    'AreaName',
    'ZoneName',
    'DungeonName',
    'InstanceName',
    'StageName',
    'RoomName',
    'CopyName',
    'Name',
]);

const FLAG_KEYS = [
    'IsRaid',
    'IsDungeon',
    'IsInstance',
    'InDungeon',
    'InRaid',
    'TeamType',
    'CopyType',
    'MatchType',
    'Mode',
    'Difficulty',
];

// Champs qu’on force à apparaître dans “Interesting fields” avec leur valeur
const ALWAYS_FIELDS = new Set([
    // cœur SceneData
    'SceneData.LineId',
    'SceneData.LevelMapId',
    'SceneData.LevelUuid',
    'SceneData.SceneGuid',
    'SceneData.RecordId',
    'SceneData.DungeonGuid',
    'SceneData.LastSceneData.SceneId',

    // variantes possibles hors du bloc SceneData
    'LevelMapId',
    'LevelUuid',
    'SceneGuid',
    'RecordId',
    'DungeonGuid',
]);

/** Stringify sûr (gère BigInt/Long et cycles) */
export function safeStringify(obj, space = 2) {
    const seen = new WeakSet();
    return JSON.stringify(
        obj,
        (k, v) => {
            if (typeof v === 'bigint') return v.toString();
            if (v && typeof v === 'object') {
                if (v.low != null && v.high != null && typeof v.toString === 'function') return v.toString(); // Long
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            return v;
        },
        space
    );
}

/** Parcours profond pour extraire toutes les clés (chemins) */
export function inventoryKeys(root, { maxDepth = 6 } = {}) {
    const keys = new Set();
    const walk = (obj, pfx = '', depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > maxDepth) return;
        for (const [k, v] of Object.entries(obj)) {
            const pathKey = pfx ? `${pfx}.${k}` : k;
            keys.add(pathKey);
            if (v && typeof v === 'object') walk(v, pathKey, depth + 1);
        }
    };
    walk(root);
    return Array.from(keys).sort();
}

/** Détecte les “clés candidates” (ids/champs utiles) avec leur valeur courante */
export function findInterestingFields(root, { maxDepth = 6 } = {}) {
    const result = [];
    const walk = (obj, pfx = '', depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > maxDepth) return;
        for (const [k, v] of Object.entries(obj)) {
            const pathKey = pfx ? `${pfx}.${k}` : k;

            // IDs plausibles (ou whiteliste explicite)
            if (ID_KEY_RX.test(k) || ALWAYS_FIELDS.has(pathKey)) {
                const val = normalizeScalar(v);
                // on accepte number, string, boolean (les GUID peuvent être strings)
                if (
                    isFiniteNum(val) ||
                    typeof val === 'string' ||
                    typeof val === 'boolean'
                ) {
                    result.push({ type: 'id', key: pathKey, value: val });
                }
            }

            // Noms plausibles
            if (NAME_KEY_SET.has(k) && typeof v === 'string' && v.length) {
                result.push({ type: 'name', key: pathKey, value: v });
            }

            // Flags / métadonnées textuelles
            if (FLAG_KEYS.includes(k)) {
                const val = normalizeScalar(v);
                result.push({ type: 'flag', key: pathKey, value: val });
            }

            if (v && typeof v === 'object') walk(v, pathKey, depth + 1);
        }
    };
    walk(root);

    // tri: ids d'abord, puis flags, puis noms (ordre stable)
    return result.sort((a, b) => {
        const prio = { id: 0, flag: 1, name: 2 };
        const ap = prio[a.type] ?? 9;
        const bp = prio[b.type] ?? 9;
        if (ap !== bp) return ap - bp;
        return a.key.localeCompare(b.key);
    });
}

/** Diff rapide entre deux snapshots {key->value} (pour IDs/flags/noms extraits) */
export function diffInteresting(prevList, currList) {
    const toMap = (list) => {
        const m = new Map();
        for (const it of list) m.set(`${it.type}:${it.key}`, it.value);
        return m;
    };
    const a = toMap(prevList),
        b = toMap(currList);
    const added = [],
        removed = [],
        changed = [];

    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const k of keys) {
        const va = a.get(k),
            vb = b.get(k);
        if (va === undefined && vb !== undefined) added.push({ k, value: vb });
        else if (va !== undefined && vb === undefined) removed.push({ k, value: va });
        else if (!isSameValue(va, vb)) changed.push({ k, from: va, to: vb });
    }
    return { added, removed, changed };
}

/** Écrit un dump JSON brut + un résumé lisible */
export function dumpSnapshot(outDir, label, vData, logger) {
    try {
        fs.mkdirSync(outDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const rawPath = path.join(outDir, `${ts}_${label}_raw.json`);
        const summaryPath = path.join(outDir, `${ts}_${label}_summary.txt`);

        fs.writeFileSync(rawPath, safeStringify(vData, 2), 'utf8');

        const keys = inventoryKeys(vData);
        const interesting = findInterestingFields(vData);
        const summary = [
            `# ${label}`,
            `time: ${ts}`,
            `raw: ${rawPath}`,
            '',
            '## Interesting fields:',
            ...interesting.map((x) => `- [${x.type}] ${x.key} = ${String(x.value)}`),
            '',
            '## All keys:',
            ...keys,
        ].join('\n');

        fs.writeFileSync(summaryPath, summary, 'utf8');
        logger?.info?.(`[INSPECT] snapshot dumped: ${summaryPath}`);
        return { rawPath, summaryPath, interesting };
    } catch (e) {
        logger?.warn?.('[INSPECT] dumpSnapshot failed', { err: e?.message });
        return null;
    }
}

/** Utilitaires */
function isFiniteNum(v) {
    return Number.isFinite(Number(v));
}
function isSameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b);
    return String(a) === String(b);
}
function normalizeScalar(v) {
    if (v == null) return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'object') {
        // Long from long.js
        if (
            v &&
            typeof v.low === 'number' &&
            typeof v.high === 'number' &&
            typeof v.toString === 'function'
        ) {
            // retourner Number si sûr, sinon string
            const s = v.toString();
            const n = Number(s);
            return Number.isFinite(n) ? n : s;
        }
        return v; // string/bool/etc. laissons tel quel
    }
    return v;
}
