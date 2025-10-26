// src/routes/sessions.js
import express from "express";
import { randomUUID } from "node:crypto";
import { addSession, listSessions, getSession } from "../services/Sessions.js";
import { deleteSession, clearSessions } from "../services/Sessions.js";

const router = express.Router();

router.get("/", (req, res) => {
    res.json({ code: 0, data: listSessions() });
});

router.get("/:id", (req, res) => {
    const sess = getSession(req.params.id);
    if (!sess) return res.status(404).json({ code: 1, msg: "Session not found" });
    res.json({ code: 0, data: sess });
});

router.post("/", express.json({ limit: "5mb" }), (req, res) => {
    try {
        const body = req.body || {};
        const id = randomUUID();
        const session = {
            id,
            name: body.name || body.bossName || "Run",
            startedAt: body.startedAt ?? Date.now(),
            endedAt: body.endedAt ?? Date.now(),
            durationMs: Math.max(0, (body.endedAt ?? Date.now()) - (body.startedAt ?? Date.now())),
            partySize: (body.players || []).length,
            snapshot: body,
        };
        addSession(session);
        res.json({ code: 0, id });
    } catch (e) {
        console.error("[/api/sessions] save failed:", e);
        res.status(500).json({ code: 1, msg: "Failed to save session" });
    }
});

// DELETE one
router.delete("/:id", (req, res) => {
    const ok = deleteSession(req.params.id);
    if (!ok) return res.status(404).json({ code: 1, msg: "Session not found" });
    res.json({ code: 0 });
});

// DELETE all
router.delete("/", (_req, res) => {
    clearSessions();
    res.json({ code: 0 });
});

export default router;
