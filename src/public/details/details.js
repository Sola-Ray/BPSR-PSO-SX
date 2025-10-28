/* eslint-disable no-undef */
(() => {
    "use strict";

    // ===== State =====
    let DATA = null;
    let sortKey = "shareDmg";
    let sortDir = "desc";
    let sortingBound = false;
    let lastRenderKey = "";
    let sizedOnce = false;
    let modeFilter = "all";

    // ===== DOM =====
    const $ = (s, r = document) => r.querySelector(s);
    const tbody = $("#spellTbody");
    const thead = $("#spellTable thead");
    const summary = $("#spellSummary");
    const footer = $("#spellFooter");
    const search = $("#spellSearch");
    const tableWrap = $(".table-wrap");
    const sumDmg = $("#sumDmg");
    const sumHeal = $("#sumHeal");
    const sumCasts = $("#sumCasts");

    // ===== Const =====
    const HEAL_OFFSET = 1_000_000_000;
    const PREF_KEY = "details_prefs";
    const numberFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });

    // ===== Oscilloscope config =====
    const SCOPE_WINDOW_SEC = 60;
    const SCOPE_TARGET_FPS = 30;
    const SCOPE_EMA_ALPHA = 0.2;
    let scopeData = [];   // [{t,dps,hps,dpsEma,hpsEma}]
    let lastRedraw = 0;
    let scopeCanvas, scopeCtx, scopeDPR = 1;
    let scopeHoverX = null;

    // ===== Utils =====
    const formatNumber = (n) => (isFinite(n) ? numberFmt.format(n) : "NaN");
    const setNumCellText = (cell, value) => { cell.textContent = formatNumber(value); cell.title = String(value); };

    const renderHeader = () => {
        thead.querySelectorAll("th").forEach(th => th.classList.remove("th-sort-asc", "th-sort-desc"));
        const th = thead.querySelector(`th[data-sort="${sortKey}"]`);
        if (th) th.classList.add(sortDir === "asc" ? "th-sort-asc" : "th-sort-desc");
    };

    const aggregateItems = (items) => {
        const byBase = new Map();
        for (const it of items) {
            const baseId = Number(it.id) % HEAL_OFFSET;
            const key = String(baseId);
            const entry = byBase.get(key) || { id: key, name: it.name, damage: 0, heal: 0, casts: 0, dmgCasts: 0, healCasts: 0, kind: "dmg" };

            if (!entry.name || (it.name && String(it.name).length > String(entry.name).length)) entry.name = it.name;

            const type = (it.type || "").toLowerCase();
            const amount = it.damage || it.totalDamage || 0;
            const count = Number(it.casts ?? it.totalCount ?? (it.countBreakdown && typeof it.countBreakdown.total === "number" ? it.countBreakdown.total : undefined) ?? it.hits ?? 0) || 0;

            if (type === "healing" || Number(it.id) >= HEAL_OFFSET) { entry.heal += amount; entry.healCasts += count; }
            else { entry.damage += amount; entry.dmgCasts += count; }

            entry.casts = entry.dmgCasts + entry.healCasts;
            entry.kind = (entry.damage && entry.heal) ? "mix" : (entry.heal ? "heal" : "dmg");
            byBase.set(key, entry);
        }
        return [...byBase.values()].map(r => ({ ...r, name: String(r?.name ?? r?.label ?? r?.title ?? r.id ?? "") }));
    };

    const getTotals = (rows) => ({
        totalDamage: rows.reduce((s, r) => s + (r.damage || 0), 0),
        totalHeal: rows.reduce((s, r) => s + (r.heal || 0), 0),
        totalCasts: rows.reduce((s, r) => s + (r.casts || 0), 0),
    });

    const getSortedFilteredData = (rows, totals) => {
        const filter = String(search?.value ?? "").toLowerCase();

        const data = rows
            .filter(r => String(r.name ?? "").toLowerCase().includes(filter))
            .filter(r => modeFilter === "all" ? true : (modeFilter === "dmg" ? r.damage > 0 : r.heal > 0))
            .map(r => ({
                ...r,
                shareDmg: totals.totalDamage > 0 ? (r.damage / totals.totalDamage) * 100 : 0,
                shareHeal: totals.totalHeal > 0 ? (r.heal / totals.totalHeal) * 100 : 0,
            }));

        const dir = sortDir === "asc" ? 1 : -1;
        data.sort((a, b) => {
            if (sortKey === "name") {
                const an = String(a.name ?? a.id ?? "");
                const bn = String(b.name ?? b.id ?? "");
                return an.localeCompare(bn, "en", { sensitivity: "base" }) * dir;
            }
            return (((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir);
        });

        return data;
    };

    const buildRow = (r, totals, maxDmg, maxHeal) => {
        const tr = document.createElement("tr");
        tr.dataset.id = r.id;

        const tdName = document.createElement("td");
        const rowName = document.createElement("div");
        rowName.className = "spell-row-name";

        const badge = document.createElement("span");
        badge.className = `badge ${r.kind}`;
        badge.textContent = r.kind.toUpperCase();
        badge.ariaLabel = r.kind;

        const icon = document.createElement("img");
        icon.className = "spell-icon";
        icon.alt = "";
        icon.decoding = "async";
        icon.loading = "lazy";
        icon.src = `../assets/skills/${r.id}.webp`;
        icon.addEventListener("error", () => icon.remove(), { passive: true });

        const nameEl = document.createElement("div");
        nameEl.className = "spell-name";
        nameEl.textContent = r.name;

        const bars = document.createElement("div");
        bars.className = "dual-bars";

        const barD = document.createElement("div");
        barD.className = "bar damage";
        const fillD = document.createElement("span");
        fillD.className = "fill";
        const wD = maxDmg > 0 ? ((r.damage / maxDmg) * 100).toFixed(3) + "%" : "0%";
        fillD.style.width = wD; fillD.title = `Damage: ${r.damage}`;
        barD.appendChild(fillD);

        const barH = document.createElement("div");
        barH.className = "bar heal";
        const fillH = document.createElement("span");
        fillH.className = "fill";
        const wH = maxHeal > 0 ? ((r.heal / maxHeal) * 100).toFixed(3) + "%" : "0%";
        fillH.style.width = wH; fillH.title = `Heal: ${r.heal}`;
        barH.appendChild(fillH);

        bars.append(barD, barH);
        rowName.append(badge, icon, nameEl);
        tdName.append(rowName, bars);

        const tdDmg = document.createElement("td"); tdDmg.className = "col-num"; setNumCellText(tdDmg, r.damage);
        const tdHeal = document.createElement("td"); tdHeal.className = "col-num"; setNumCellText(tdHeal, r.heal);
        const tdCasts = document.createElement("td"); tdCasts.className = "col-casts"; setNumCellText(tdCasts, r.casts);

        const tdShareD = document.createElement("td"); tdShareD.className = "col-share";
        const vD = totals.totalDamage > 0 ? (r.damage / totals.totalDamage * 100) : 0;
        tdShareD.textContent = `${vD.toFixed(1)}%`; tdShareD.title = vD.toString();

        const tdShareH = document.createElement("td"); tdShareH.className = "col-share";
        const vH = totals.totalHeal > 0 ? (r.heal / totals.totalHeal * 100) : 0;
        tdShareH.textContent = `${vH.toFixed(1)}%`; tdShareH.title = vH.toString();

        tr.append(tdName, tdDmg, tdHeal, tdCasts, tdShareD, tdShareH);
        return tr;
    };

    const renderSummary = (totals) => {
        const { user } = DATA;
        summary.replaceChildren();
        const chips = [
            { label: "Class", value: user.profession },
            { label: "DPS", value: formatNumber(user.realtime_dps) },
            { label: "Max DPS", value: formatNumber(user.realtime_dps_max) },
            { label: "HPS", value: formatNumber(user.realtime_hps) },
            { label: "Max HPS", value: formatNumber(user.realtime_hps_max) },
            { label: "Total Damage", value: formatNumber(totals.totalDamage) },
            { label: "Total Healing", value: formatNumber(totals.totalHeal) },
            { label: "Hits", value: user.total_count.total },
            { label: "FP", value: user.fightPoint },
            { label: "Max HP", value: user.max_hp },
            { label: "Deaths", value: user.dead_count },
        ];
        for (const c of chips) {
            const span = document.createElement("span");
            span.className = "spell-chip";
            span.textContent = `${c.label}: ${c.value}`;
            summary.appendChild(span);
        }
        $("#popupTitle").textContent = `${user.name}`;

        // Footer text with safe HTML entities
        footer.innerHTML = `
      Total:&nbsp;<strong>${formatNumber(totals.totalDamage)}</strong>&nbsp;dmg
      &nbsp;&bull;&nbsp;<strong>${formatNumber(totals.totalHeal)}</strong>&nbsp;heal
      &nbsp;&bull;&nbsp;<strong>${tbody.children.length}</strong>&nbsp;skills
    `;
    };

    const rebuildTable = () => {
        const { items } = DATA;
        const rows = aggregateItems(items);
        const totals = getTotals(rows);
        const data = getSortedFilteredData(rows, totals);

        const maxDmg = Math.max(0, ...data.map(r => r.damage || 0));
        const maxHeal = Math.max(0, ...data.map(r => r.heal || 0));

        tbody.replaceChildren();
        const frag = document.createDocumentFragment();
        for (const r of data) frag.appendChild(buildRow(r, totals, maxDmg, maxHeal));
        tbody.appendChild(frag);

        setNumCellText(sumDmg, totals.totalDamage);
        setNumCellText(sumHeal, totals.totalHeal);
        setNumCellText(sumCasts, totals.totalCasts);

        renderSummary(totals);

        // Feed scope and size window
        pushScopePoint(Number(DATA?.user?.realtime_dps || 0), Number(DATA?.user?.realtime_hps || 0));
        maybeRedrawScope();
        setInitialSizeOnce();
    };

    const updateValuesOnly = () => {
        const { items } = DATA;
        const rows = aggregateItems(items);
        const totals = getTotals(rows);
        const data = getSortedFilteredData(rows, totals);

        const currentRows = Array.from(tbody.children);
        const currentIds = new Set(currentRows.map(r => r.dataset.id));
        const newIds = new Set(data.map(d => String(d.id)));
        if (currentRows.length !== data.length || ![...currentIds].every(id => newIds.has(id))) {
            rebuildTable(); return;
        }

        const maxDmg = Math.max(0, ...data.map(r => r.damage || 0));
        const maxHeal = Math.max(0, ...data.map(r => r.heal || 0));

        tbody.querySelectorAll(".fill").forEach(f => f.style.transition = "none");

        for (const r of data) {
            const tr = tbody.querySelector(`tr[data-id="${r.id}"]`); if (!tr) continue;

            const nums = tr.querySelectorAll(".col-num");
            if (nums[0]) setNumCellText(nums[0], r.damage);
            if (nums[1]) setNumCellText(nums[1], r.heal);

            const castsCell = tr.querySelector(".col-casts");
            if (castsCell) setNumCellText(castsCell, r.casts);

            const shares = tr.querySelectorAll(".col-share");
            if (shares[0]) {
                const v = totals.totalDamage > 0 ? (r.damage / totals.totalDamage * 100) : 0;
                shares[0].textContent = `${v.toFixed(1)}%`; shares[0].title = v.toString();
            }
            if (shares[1]) {
                const v = totals.totalHeal > 0 ? (r.heal / totals.totalHeal * 100) : 0;
                shares[1].textContent = `${v.toFixed(1)}%`; shares[1].title = v.toString();
            }

            const fills = tr.querySelectorAll(".fill");
            if (fills[0]) {
                const w = maxDmg > 0 ? ((r.damage / maxDmg) * 100).toFixed(3) + "%" : "0%";
                fills[0].style.width = w; fills[0].title = `Damage: ${r.damage}`;
            }
            if (fills[1]) {
                const w = maxHeal > 0 ? ((r.heal / maxHeal) * 100).toFixed(3) + "%" : "0%";
                fills[1].style.width = w; fills[1].title = `Heal: ${r.heal}`;
            }
        }
        setTimeout(() => tbody.querySelectorAll(".fill").forEach(f => f.style.transition = "width .35s ease"), 50);

        setNumCellText(sumDmg, totals.totalDamage);
        setNumCellText(sumHeal, totals.totalHeal);
        setNumCellText(sumCasts, totals.totalCasts);
        renderSummary(totals);

        // Feed and redraw scope
        pushScopePoint(Number(DATA?.user?.realtime_dps || 0), Number(DATA?.user?.realtime_hps || 0));
        maybeRedrawScope();
    };

    const bindSortingOnce = () => {
        if (sortingBound) return;
        sortingBound = true;

        thead.querySelectorAll("th[data-sort]").forEach(th => {
            th.addEventListener("click", () => {
                const key = th.getAttribute("data-sort");
                if (key === sortKey) sortDir = (sortDir === "asc") ? "desc" : "asc";
                else { sortKey = key; sortDir = "desc"; }
                savePrefs(); renderHeader(); rebuildTable();
            }, { passive: true });
        });

        tableWrap.addEventListener("scroll", () => {
            thead.classList.toggle("stuck", tableWrap.scrollTop > 0);
        }, { passive: true });

        document.querySelectorAll(".seg-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                modeFilter = btn.dataset.mode;
                savePrefs(); rebuildTable();
            }, { passive: true });
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "/" && document.activeElement !== search) {
                e.preventDefault(); search.focus();
            }
            if (e.key === "Escape") maybeClose();
        });

        document.addEventListener("click", (e) => {
            const t = e.target;
            if (t && t.matches('[data-action="close"]')) maybeClose();
        }, { passive: true });

        ["input", "change", "keyup"].forEach(ev => {
            search.addEventListener(ev, () => { savePrefs(); rebuildTable(); });
        });
    };

    const maybeClose = () => {
        try {
            if (window.electronAPI?.closeChildWindow) {
                window.electronAPI.closeChildWindow("SpellDetails");
            } else {
                window.close();
            }
        } catch { window.close(); }
    };

    const setInitialSizeOnce = () => {
        if (sizedOnce) return; sizedOnce = true;
        try {
            const table = document.getElementById("spellTable");
            const headW = table.tHead?.getBoundingClientRect().width || 960;
            const margin = 40;
            const w = Math.min(screen.availWidth, Math.ceil(headW + margin));
            const baseHeader = 56 + 60 + 70;
            const rowHeight = 36;
            const rowsWanted = 18;
            const h = Math.min(screen.availHeight, baseHeader + rowHeight * rowsWanted + 80);

            if (window.electronAPI?.resizeChildWindow) {
                window.electronAPI.resizeChildWindow("SpellDetails", w, h);
            } else {
                window.resizeTo(w, h);
            }
        } catch { }
    };

    const loadPrefs = () => {
        try {
            const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
            if (p.sortKey) sortKey = p.sortKey;
            if (p.sortDir) sortDir = p.sortDir;
            if (p.search != null) search.value = p.search;
            if (p.modeFilter) {
                modeFilter = p.modeFilter;
                document.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === modeFilter));
            }
        } catch { }
    };
    const savePrefs = () => {
        localStorage.setItem(PREF_KEY, JSON.stringify({ sortKey, sortDir, search: search.value, modeFilter }));
    };
    const niceStep = (max) => {
        // renvoie un "tick" agréable (1,2,5 * 10^n)
        const exp = Math.floor(Math.log10(max || 1));
        const f = max / Math.pow(10, exp);
        let nf = 1; if (f > 1.5) nf = 2; if (f > 3.5) nf = 5; if (f > 7.5) nf = 10;
        return nf * Math.pow(10, exp);
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const findPointAtX = (data, xFrac) => {
        // xFrac in [0..1] => approx point by time
        if (!data.length) return data.at(-1);
        const t1 = data[0].t, t2 = data.at(-1).t;
        const tt = lerp(t1, t2, clamp(xFrac, 0, 1));
        // binary search closest
        let lo = 0, hi = data.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (data[mid].t < tt) lo = mid; else hi = mid;
        }
        const a = data[lo], b = data[hi];
        const k = (tt - a.t) / Math.max(1e-6, b.t - a.t);
        return {
            t: tt,
            dps: lerp(a.dps, b.dps, k),
            hps: lerp(a.hps, b.hps, k),
            dpsEma: lerp(a.dpsEma, b.dpsEma, k),
            hpsEma: lerp(a.hpsEma, b.hpsEma, k),
        };
    };


    // ===== Oscilloscope =====
    const initScopeCanvas = () => {
        scopeCanvas = document.getElementById("scopeCanvas");
        if (!scopeCanvas) return;
        scopeDPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const rect = scopeCanvas.getBoundingClientRect();
        scopeCanvas.width = Math.round(rect.width * scopeDPR);
        scopeCanvas.height = Math.round(rect.height * scopeDPR);
        scopeCtx = scopeCanvas.getContext("2d");
        scopeCtx.setTransform(scopeDPR, 0, 0, scopeDPR, 0, 0); // unit = CSS px

        // interaction
        scopeCanvas.onmousemove = (e) => {
            const r = scopeCanvas.getBoundingClientRect();
            scopeHoverX = Math.max(0, Math.min(r.width, e.clientX - r.left));
            drawScope();
        };
        scopeCanvas.onmouseleave = () => { scopeHoverX = null; drawScope(); };
    };

    const pushScopePoint = (dps, hps) => {
        const now = performance.now() / 1000;
        const last = scopeData.at(-1);
        const dpsEma = last ? (SCOPE_EMA_ALPHA * dps + (1 - SCOPE_EMA_ALPHA) * last.dpsEma) : dps;
        const hpsEma = last ? (SCOPE_EMA_ALPHA * hps + (1 - SCOPE_EMA_ALPHA) * last.hpsEma) : hps;
        scopeData.push({ t: now, dps, hps, dpsEma, hpsEma });
        const cutoff = now - SCOPE_WINDOW_SEC;
        while (scopeData.length && scopeData[0].t < cutoff) scopeData.shift();
    };

    const drawScope = () => {
        if (!scopeCtx || !scopeCanvas) return;
        const { width: W, height: H } = scopeCanvas.getBoundingClientRect();
        scopeCtx.clearRect(0, 0, W, H);

        // --- layout (gutter gauche pour les labels Y) ---
        const m = { l: 56, r: 10, t: 8, b: 22 };
        const panel = { x: m.l, y: m.t, w: W - m.l - m.r, h: H - m.t - m.b };

        // fond léger
        scopeCtx.fillStyle = "rgba(255,255,255,.02)";
        scopeCtx.fillRect(0, 0, W, H);

        if (!scopeData.length) return;

        // graduation dynamique : prend un multiple agréable (10k, 20k, 50k, etc.)
        const base = 10_000;
        let Y_TICK = base;

        if (maxAll > 200_000) Y_TICK = 50_000;
        else if (maxAll > 100_000) Y_TICK = 20_000;
        else if (maxAll > 60_000) Y_TICK = 10_000;
        else if (maxAll > 30_000) Y_TICK = 5_000;
        else if (maxAll > 10_000) Y_TICK = 2_000;
        else Y_TICK = 1_000;

        const maxY = Math.ceil(maxAll / Y_TICK) * Y_TICK;


        const now = scopeData.at(-1).t;
        const t0 = now - SCOPE_WINDOW_SEC;
        const tx = (t) => panel.x + ((t - t0) / SCOPE_WINDOW_SEC) * panel.w;
        const ty = (v) => panel.y + panel.h - (v / maxY) * panel.h;

        // --- Gutter Y + grilles horizontales (tous les 10k) ---
        scopeCtx.fillStyle = "rgba(255,255,255,.02)";
        scopeCtx.fillRect(0, panel.y, m.l - 6, panel.h);

        scopeCtx.strokeStyle = "rgba(255,255,255,.10)";
        scopeCtx.lineWidth = 1;
        for (let v = 0; v <= maxY; v += Y_TICK) {
            const yy = ty(v);
            scopeCtx.beginPath(); scopeCtx.moveTo(panel.x, yy); scopeCtx.lineTo(panel.x + panel.w, yy); scopeCtx.stroke();

            scopeCtx.fillStyle = "rgba(255,255,255,.85)";
            scopeCtx.font = "11px system-ui, sans-serif";
            scopeCtx.textAlign = "right"; scopeCtx.textBaseline = "middle";
            scopeCtx.fillText(numberFmt.format(v), m.l - 10, yy);
        }

        // contour
        scopeCtx.strokeStyle = "rgba(255,255,255,.16)";
        scopeCtx.strokeRect(panel.x, panel.y, panel.w, panel.h);

        // --- Courbes (chevauchées) ---
        const drawSeries = (color, acc) => {
            scopeCtx.strokeStyle = color; scopeCtx.lineWidth = 2; scopeCtx.setLineDash([]);
            scopeCtx.beginPath();
            let first = true;
            for (const p of scopeData) {
                const X = tx(p.t), Y = ty(acc(p));
                if (first) { scopeCtx.moveTo(X, Y); first = false; } else scopeCtx.lineTo(X, Y);
            }
            scopeCtx.stroke();
        };

        const drawEma = (color, acc) => {
            scopeCtx.setLineDash([6, 4]);
            scopeCtx.strokeStyle = color; scopeCtx.lineWidth = 2;
            scopeCtx.beginPath();
            let first = true;
            for (const p of scopeData) {
                const X = tx(p.t), Y = ty(acc(p));
                if (first) { scopeCtx.moveTo(X, Y); first = false; } else scopeCtx.lineTo(X, Y);
            }
            scopeCtx.stroke();
            scopeCtx.setLineDash([]);
        };

        // DPS instant + EMA
        drawSeries("#ff8080", p => p.dps);
        drawEma("#ff4d4f", p => p.dpsEma);

        // HPS instant + EMA
        drawSeries("#7ee28a", p => p.hps);
        drawEma("#35c24d", p => p.hpsEma);

        // --- Moyennes (traits fins) ---
        const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
        const dAvg = avg(scopeData, "dps");
        const hAvg = avg(scopeData, "hps");

        scopeCtx.lineWidth = 1.25;

        scopeCtx.strokeStyle = "#ffb3b3";
        scopeCtx.beginPath(); scopeCtx.moveTo(panel.x, ty(dAvg)); scopeCtx.lineTo(panel.x + panel.w, ty(dAvg)); scopeCtx.stroke();

        scopeCtx.strokeStyle = "#b7f2bf";
        scopeCtx.beginPath(); scopeCtx.moveTo(panel.x, ty(hAvg)); scopeCtx.lineTo(panel.x + panel.w, ty(hAvg)); scopeCtx.stroke();

        // --- Ticks du temps (0..60s) ---
        scopeCtx.fillStyle = "rgba(255,255,255,.75)";
        scopeCtx.font = "11px system-ui, sans-serif";
        scopeCtx.textAlign = "center"; scopeCtx.textBaseline = "top";
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
            const tt = t0 + (i / ticks) * SCOPE_WINDOW_SEC;
            const X = tx(tt);
            scopeCtx.fillText(`${(SCOPE_WINDOW_SEC - Math.round((tt - t0))).toString()}s`, X, panel.y + panel.h + 2);
        }

        // --- Légende (valeurs live) ---
        const nowP = scopeData.at(-1);
        document.getElementById("lgDpsNow").textContent = numberFmt.format(nowP?.dps || 0);
        document.getElementById("lgDpsAvg").textContent = numberFmt.format(dAvg);
        document.getElementById("lgHpsNow").textContent = numberFmt.format(nowP?.hps || 0);
        document.getElementById("lgHpsAvg").textContent = numberFmt.format(hAvg);

    };

    const maybeRedrawScope = () => {
        const now = performance.now();
        if (now - lastRedraw > (1000 / SCOPE_TARGET_FPS)) {
            lastRedraw = now;
            drawScope();
        }
    };

    // ===== Message bridge =====
    const handleMessage = (ev) => {
        if (!ev?.data || ev.data.type !== "spell-data") return;
        DATA = ev.data.payload;
        loadPrefs(); bindSortingOnce(); renderHeader();
        const key = `${DATA.user.id}_${DATA.items.length}_${sortKey}_${sortDir}_${modeFilter}_prefs_v1`;
        if (key !== lastRenderKey) { rebuildTable(); lastRenderKey = key; }
        else { updateValuesOnly(); }
    };

    // ===== Init =====
    window.addEventListener("message", handleMessage);
    window.receiveSpellData = (payload) => handleMessage({ data: { type: "spell-data", payload } });

    window.addEventListener("DOMContentLoaded", () => {
        try {
            initScopeCanvas();
            window.addEventListener("resize", initScopeCanvas, { passive: true });
            setInterval(maybeRedrawScope, Math.round(1000 / SCOPE_TARGET_FPS));

            if (window.opener) {
                window.opener.postMessage({ type: "details-ready" }, "*");
            }
        } catch { }
    });

})();
