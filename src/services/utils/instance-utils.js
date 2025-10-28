// ESM, Node 18+
import fs from 'fs';
import { fileURLToPath } from 'url';

/** Retourne true si v est un nombre fini (supporte strings numériques). */
export const isFiniteNumber = (v) => Number.isFinite(Number(v));

/** Lecture JSON synchrone “sûre”. Retourne null en cas d’échec. */
export const safeReadJSON = (pOrUrl, logger) => {
    try {
        const pathStr = typeof pOrUrl === 'string' ? pOrUrl : fileURLToPath(pOrUrl);
        if (!fs.existsSync(pathStr)) return null;
        return JSON.parse(fs.readFileSync(pathStr, 'utf8'));
    } catch (e) {
        logger?.warn?.('JSON load failed', { path: String(pOrUrl), err: e?.message });
        return null;
    }
};

/** u64 (high/low) → string (fallback toString) */
export const u64ToString = (u) => {
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

/** Dérive l’ID de scène depuis un vData hétérogène. */
export const deriveSceneId = (vData) => {
    const id = Number(vData?.SceneData?.LevelMapId);
    return Number.isFinite(id) ? id : null;
};

/** Dérive le lineId (canal) depuis un vData. */
export const deriveLineId = (vData) => {
    const id = Number(vData?.SceneData?.LineId);
    return Number.isFinite(id) ? id : null;
};
