(() => {
    "use strict";

    /* ========== Helpers locaux (autonomes) ========== */
    const toStr = (v) => String(v ?? "");
    const toNum = (v, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };

    const NF_INTL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    const DF_INTL = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

    const fmt = (n) => NF_INTL.format(Math.round(toNum(n)));
    const short = (n = 0) => {
        const x = Math.round(toNum(n));
        if (x >= 1_000_000_000) return `${(x / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
        if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
        if (x >= 1_000) return `${(x / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
        return String(x);
    };
    const msToClock = (ms) => {
        const s = Math.max(0, Math.floor(toNum(ms) / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `${h ? `${h}h ` : ""}${m}m ${sec}s`;
    };

    /* ========== Classe → icône (copié/isolé pour autonomie) ========== */
    const CLASS_ICON_MAP = Object.freeze({
        wind_knight: "/assets/classes/wind_knight.webp",
        stormblade: "/assets/classes/stormblade.webp",
        frost_mage: "/assets/classes/frost_mage.webp",
        heavy_guardian: "/assets/classes/heavy_guardian.webp",
        shield_knight: "/assets/classes/shield_knight.webp",
        marksman: "/assets/classes/marksman.webp",
        soul_musician: "/assets/classes/soul_musician.webp",
        verdant_oracle: "/assets/classes/verdant_oracle.webp",
        default: "/assets/classes/default.webp",
    });
    const getClassKey = (profession = "") => {
        const p = toStr(profession).toLowerCase();
        if (p.includes("wind")) return "wind_knight";
        if (p.includes("storm")) return "stormblade";
        if (p.includes("frost")) return "frost_mage";
        if (p.includes("guardian")) return "heavy_guardian";
        if (p.includes("shield")) return "shield_knight";
        if (p.includes("mark")) return "marksman";
        if (p.includes("soul")) return "soul_musician";
        if (p.includes("verdant")) return "verdant_oracle";
        return "default";
    };
    const classIconFor = (p = {}) => {
        const explicit = p.classIcon ?? p.class_icon ?? p.professionIcon ?? p.iconUrl ?? p.icon_path;
        if (explicit) return explicit;
        const key = getClassKey(p.class ?? p.className ?? p.playerClass ?? p.profession ?? p.cls ?? "");
        return CLASS_ICON_MAP[key] || CLASS_ICON_MAP.default;
    };
    const roleFromPlayer = (p) => p.role || ((toNum(p.hps) > toNum(p.dps)) ? "heal" : "dps");

    /* ========== Canvas utils ========== */
    function drawRoundedRect(ctx, x, y, w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }
    function text(ctx, str, x, y, font, color, align = "left", baseline = "alphabetic", maxWidth) {
        ctx.save();
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        if (maxWidth) ctx.fillText(str, x, y, maxWidth);
        else ctx.fillText(str, x, y);
        ctx.restore();
    }
    function bar(ctx, x, y, w, h, ratio, bg = "#2A2F4A", fg = "#6C8FF5") {
        ctx.save();
        drawRoundedRect(ctx, x, y, w, h, h / 2);
        ctx.fillStyle = bg; ctx.fill();
        const ww = Math.max(0, Math.min(w, Math.round(w * ratio)));
        if (ww > 0) {
            drawRoundedRect(ctx, x, y, ww, h, h / 2);
            ctx.fillStyle = fg; ctx.fill();
        }
        ctx.restore();
    }
    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    /* ========== Génération d'image ========== */
    async function createShareImageFromSession(sess, options = {}) {
        const PAD = 32, W = 1200, ROW_H = 112, HEADER_H = 140, GAP = 14;

        const players = (sess?.snapshot?.players ?? []).slice();
        if (!players.length) throw new Error("Aucune donnée joueur");

        // Ordre d'affichage (damage décroissant par défaut)
        const sortKey = {
            damage: (p) => p?.totals?.damage || 0,
            healing: (p) => p?.totals?.heal || 0,
            dps: (p) => p?.dps || 0,
            hps: (p) => p?.hps || 0,
            name: (p) => (p?.name || "").toLowerCase(),
        };
        const sortBy = options.sortBy || "damage";
        players.sort((a, b) => sortBy === "name"
            ? (a?.name || "").localeCompare(b?.name || "")
            : (sortKey[sortBy](b) - sortKey[sortBy](a)));

        const maxDamage = Math.max(1, ...players.map(p => p?.totals?.damage || 0));
        const maxHeal = Math.max(1, ...players.map(p => p?.totals?.heal || 0));

        const icons = await Promise.all(players.map(p => loadImage(classIconFor(p))));

        const scale = Math.max(2, Math.min(3, Math.ceil(window.devicePixelRatio || 1.5)));
        const H = HEADER_H + PAD + players.length * (ROW_H + GAP) + PAD;

        const canvas = document.createElement("canvas");
        canvas.width = W * scale; canvas.height = H * scale;
        const ctx = canvas.getContext("2d");
        ctx.scale(scale, scale);

        // Fond + carte
        ctx.fillStyle = "#0F1220"; ctx.fillRect(0, 0, W, H);
        const cardX = PAD, cardY = PAD, cardW = W - PAD * 2, cardH = H - PAD * 2;
        drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 16);
        ctx.fillStyle = "#161A2B"; ctx.fill();

        // Titre + métas
        const titleFont = "700 32px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
        const metaFont = "500 18px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
        const monoFont = "600 18px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

        const titleY = cardY + 48;
        text(ctx, toStr(sess?.name || "Run"), cardX + 28, titleY, titleFont, "#FFFFFF", "left", "alphabetic");

        const dt = sess?.startedAt ? DF_INTL.format(new Date(sess.startedAt)) : "—";
        const dur = msToClock(sess?.durationMs ?? 0);
        const sz = toNum(sess?.partySize);
        const meta = `${dt}   •   Durée: ${dur}   •   Joueurs: ${sz}`;
        text(ctx, meta, cardX + 28, titleY + 34, metaFont, "#A6ADCE", "left", "alphabetic");

        // Lignes joueurs
        let y = cardY + HEADER_H;
        const nameFont = "700 22px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
        const subFont = "500 14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
        const rowPad = 18, avatarSize = 72, barWidth = 420, barHeight = 10;

        players.forEach((p, i) => {
            const rowX = cardX + 16, rowY = y, rowW = cardW - 32, rowH = ROW_H;

            // fond ligne
            drawRoundedRect(ctx, rowX, rowY, rowW, rowH, 12);
            ctx.fillStyle = i % 2 ? "#1B2036" : "#171C30"; ctx.fill();

            const icon = icons[i];
            const role = roleFromPlayer(p);
            const dmgTotal = p?.totals?.damage || 0;
            const healTotal = p?.totals?.heal || 0;

            // icône
            const ix = rowX + rowPad, iy = rowY + (rowH - avatarSize) / 2;
            ctx.save();
            drawRoundedRect(ctx, ix, iy, avatarSize, avatarSize, 12);
            ctx.clip();
            ctx.drawImage(icon, ix, iy, avatarSize, avatarSize);
            ctx.restore();

            // nom + classe
            const leftColX = ix + avatarSize + 16;
            const nameY = rowY + 32;
            text(ctx, toStr(p.name || "—"), leftColX, nameY, nameFont, "#FFFFFF");
            text(ctx, toStr(p.class ?? p.className ?? p.playerClass ?? p.profession ?? p.cls ?? "—"),
                leftColX, nameY + 22, subFont, "#A6ADCE");

            // pill rôle
            const pillText = (p.role || "").toUpperCase() || (role === "heal" ? "HEAL" : "DPS");
            const pillFont = "700 12px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
            const measure = (() => { const c = document.createElement("canvas").getContext("2d"); c.font = pillFont; return c; })();
            const pillW = Math.ceil(measure.measureText(pillText).width) + 20;
            const pillH = 22, pillX = leftColX, pillY = rowY + rowH - pillH - rowPad;
            drawRoundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
            ctx.fillStyle = role === "heal" ? "#2A9D8F" : "#6C8FF5"; ctx.fill();
            text(ctx, pillText, pillX + pillW / 2, pillY + pillH / 2 + 0.5, pillFont, "#0F1220", "center", "middle");

            // barres
            const midX = leftColX + 260, midY = rowY + rowPad + 6;
            text(ctx, "Damage", midX, midY, subFont, "#A6ADCE");
            bar(ctx, midX, midY + 8, barWidth, barHeight, dmgTotal / maxDamage, "#2A2F4A", "#6C8FF5");
            text(ctx, short(dmgTotal), midX + barWidth + 12, midY + 16, monoFont, "#FFFFFF");

            const healY = midY + 36;
            text(ctx, "Healing", midX, healY, subFont, "#A6ADCE");
            bar(ctx, midX, healY + 8, barWidth, barHeight, healTotal / maxHeal, "#2A2F4A", "#2A9D8F");
            text(ctx, short(healTotal), midX + barWidth + 12, healY + 16, monoFont, "#FFFFFF");

            // bloc droite DPS/HPS
            const rightX = rowX + rowW - 210;
            const statFontBig = "700 22px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
            const statFontLbl = "600 12px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
            text(ctx, fmt(p.dps || 0), rightX, rowY + 40, statFontBig, "#FFFFFF");
            text(ctx, "DPS", rightX, rowY + 56, statFontLbl, "#A6ADCE");
            text(ctx, fmt(p.hps || 0), rightX + 110, rowY + 40, statFontBig, "#FFFFFF");
            text(ctx, "HPS", rightX + 110, rowY + 56, statFontLbl, "#A6ADCE");

            y += ROW_H + GAP;
        });

        // footer
        const foot = `Session #${sess?.id ?? "—"}`;
        text(ctx, foot, cardX + 28, cardY + cardH - 16,
            "500 14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif", "#A6ADCE");

        const dataURL = canvas.toDataURL("image/png");
        const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
        return { dataURL, blob, canvas };
    }

    async function copyImageToClipboard({ dataURL, blob }) {
        try {
            if (blob && navigator.clipboard?.write) {
                const item = new ClipboardItem({ "image/png": blob });
                await navigator.clipboard.write([item]);
                return true;
            }
        } catch (_) { /* fallback below */ }
        try {
            if (dataURL && window.electronAPI?.copyImageDataURL) {
                const ok = await window.electronAPI.copyImageDataURL(dataURL);
                if (ok) return true;
            }
        } catch (_) { }
        return false;
    }

    async function shareSessionToClipboard(sess, options = {}) {
        if (!sess?.snapshot?.players?.length) throw new Error("Rien à partager");
        const img = await createShareImageFromSession(sess, options);
        const ok = await copyImageToClipboard(img);
        return ok;
    }

    // Variante « par ID » : on délègue le chargement au caller
    async function shareById(id, loader, options = {}) {
        if (!id) throw new Error("Aucune session sélectionnée");
        if (typeof loader !== "function") throw new Error("Loader manquant");
        const sess = await loader(id);
        return await shareSessionToClipboard({ ...sess, id }, options);
    }

    // Expose API globale
    window.Share = Object.freeze({
        createShareImageFromSession,
        copyImageToClipboard,
        shareSessionToClipboard,
        shareById,
        // Utilitaires si besoin ailleurs :
        _utils: { fmt, short, msToClock, classIconFor, roleFromPlayer }
    });
})();
