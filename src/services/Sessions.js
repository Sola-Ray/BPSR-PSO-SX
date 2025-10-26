// src/services/Sessions.js (ESM, Electron-safe)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function getWritableDataDir() {
    // 1) Electron → userData (écriture garantie)
    if (process.versions?.electron) {
        try {
            // import dynamique compatible ESM
            const { app } = require_electron(); // petit helper ci-dessous
            const base = path.join(app.getPath("userData"), "data");
            ensureDir(base);
            return base;
        } catch {
            // on retombe sur le fallback plus bas
        }
    }
    // 2) Dev / node simple → ./data à côté du code
    const base = path.join(__dirname, "..", "..", "data");
    ensureDir(base);
    return base;
}

// helper 'require' pour ESM sans casser le bundle
function require_electron() {
    return eval('require')("electron");
}

const DATA_DIR = getWritableDataDir();
const SESS_PATH = path.join(DATA_DIR, "sessions.json");

// init fichier
if (!fs.existsSync(SESS_PATH)) fs.writeFileSync(SESS_PATH, "[]", "utf8");

function loadAll() {
    try {
        return JSON.parse(fs.readFileSync(SESS_PATH, "utf8"));
    } catch (e) {
        fs.writeFileSync(SESS_PATH, "[]", "utf8");
        return [];
    }
}

function saveAll(all) {
    fs.writeFileSync(SESS_PATH, JSON.stringify(all, null, 2), "utf8");
}

// ──────────────── EXPORTS ────────────────

export function listSessions() {
    return loadAll()
        .map((s) => {
            const partySize =
                (typeof s.partySize === 'number' && s.partySize > 0)
                    ? s.partySize
                    : (Array.isArray(s?.snapshot?.players)
                        ? s.snapshot.players.length
                        : (typeof s.playersCount === 'number' ? s.playersCount : 0));

            const { snapshot, playersCount, ...meta } = s;
            return { ...meta, partySize };
        })
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function getSession(id) {
    return loadAll().find((s) => s.id === id) || null;
}

export function addSession(session) {
    const all = loadAll();
    all.push(session);
    saveAll(all);
    return session.id;
}

export function deleteSession(id) {
    const all = loadAll();
    const next = all.filter(s => s.id !== id);
    const changed = next.length !== all.length;
    if (changed) saveAll(next);
    return changed;
}

export function clearSessions() {
    saveAll([]);
    return true;
}
