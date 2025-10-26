import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getWritableDataDir() {
    if (process.versions?.electron) {
        try {
            const { app } = require("electron");
            const base = path.join(app.getPath("userData"), "data");
            ensureDir(base);
            return base;
        } catch {
            const fallback = path.join(process.cwd(), "data");
            ensureDir(fallback);
            return fallback;
        }
    }

    const base = path.join(__dirname, "..", "..", "data");
    ensureDir(base);
    return base;
}

const DATA_DIR = getWritableDataDir();
const SESS_PATH = path.join(DATA_DIR, "sessions.json");

if (!fs.existsSync(SESS_PATH)) {
    fs.writeFileSync(SESS_PATH, "[]", "utf8");
}

function loadAll() {
    try {
        return JSON.parse(fs.readFileSync(SESS_PATH, "utf8"));
    } catch {
        fs.writeFileSync(SESS_PATH, "[]", "utf8");
        return [];
    }
}

function saveAll(all) {
    try {
        fs.writeFileSync(SESS_PATH, JSON.stringify(all, null, 2), "utf8");
    } catch (error) {
        console.error("[Sessions] Failed to write file:", SESS_PATH, error);
        throw error;
    }
}

export function listSessions() {
    return loadAll()
        .map((s) => {
            const partySize =
                typeof s.partySize === "number" && s.partySize > 0
                    ? s.partySize
                    : Array.isArray(s?.snapshot?.players)
                        ? s.snapshot.players.length
                        : typeof s.playersCount === "number"
                            ? s.playersCount
                            : 0;

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
    const next = all.filter((s) => s.id !== id);
    const changed = next.length !== all.length;
    if (changed) saveAll(next);
    return changed;
}

export function clearSessions() {
    saveAll([]);
    return true;
}
