(() => {
    "use strict";

    /* ========== Utils ========== */
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => r.querySelectorAll(s);
    const toStr = (v) => String(v ?? "");
    const toNum = (v, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };

    const esc = (v) =>
        toStr(v)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

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
    const throttle = (fn, wait = 150) => {
        let last = 0, timer = 0, ctx, args;
        return function throttled(...a) {
            const now = Date.now();
            const remaining = wait - (now - last);
            ctx = this; args = a;
            if (remaining <= 0) {
                last = now;
                fn.apply(ctx, args);
            } else {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    last = Date.now();
                    fn.apply(ctx, args);
                }, remaining);
            }
        };
    };

    /* ========== Class mapping ========== */
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

    /* ========== API ========== */
    const withAbort = () => new AbortController();
    const assertOk = async (res, url) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
        const json = await res.json().catch(() => { throw new Error(`Invalid JSON from ${url}`); });
        if (json?.code !== 0) throw new Error(json?.msg || `API error for ${url}`);
        return json.data;
    };

    const API_BASE =
        (window.opener?.location?.origin) ||
        window.location.origin ||
        "";

    const fetchJSON = async (url, signal) =>
        assertOk(await fetch(`${API_BASE}${url}`, { signal, credentials: "same-origin" }), url);

    const fetchSessions = (signal) => fetchJSON("/api/sessions", signal);
    const fetchSessionDetail = (id, s) => fetchJSON(`/api/sessions/${encodeURIComponent(id)}`, s);

    const deleteSessionById = async (id) => {
        const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, {
            method: "DELETE",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json().catch(() => ({}));
        if (j?.code !== 0) throw new Error(j?.msg || "Delete failed");
    };

    /* ========== UI helpers ========== */
    const barSVG = (ratio, kind) => {
        const w = Math.max(0, Math.min(100, Math.round(toNum(ratio) * 100)));
        const fg = w ? `<rect class="fg-${kind}" x="0" y="0" width="${w}" height="6"></rect>` : "";
        return `
<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <rect class="bg" x="0" y="0" width="100" height="6"></rect>
  ${fg}
</svg>`;
    };
    const roleFromPlayer = (p) => p.role || ((toNum(p.hps) > toNum(p.dps)) ? "heal" : "dps");
    const roleClass = (p) => `pill role-${roleFromPlayer(p)}`;

    /* ========== State ========== */
    /** @type {"damage"|"healing"|"dps"|"hps"|"name"} */
    let sortBy = "damage";
    let filter = "all";
    const sortKey = {
        damage: (p) => p?.totals?.damage || 0,
        healing: (p) => p?.totals?.heal || 0,
        dps: (p) => p?.dps || 0,
        hps: (p) => p?.hps || 0,
        name: (p) => (p?.name || "").toLowerCase(),
    };

    const els = {
        list: $("#sessionsList"),
        grid: $("#playersGrid"),
        header: $("#sessionHeader"),
        footer: $("#footerInfo"),
        segContainer: $("#segContainer") || document,
        sortContainer: $("#sortContainer") || document,
        search: $("#sessSearch"),
        closeBtn: $("#btnClose"),
        legacyTbody: $("#sessionTbody"),
    };

    // Sélection multi & détail courant
    const selectedIds = new Set(); // ids sélectionnés (multi)
    let anchorId = null;           // point d’ancrage pour Shift
    let currentDetailId = null;    // id dont on affiche le détail
    let firstRenderDone = false;

    // Abort refs
    let listAbort, detailAbort;

    /* ========== Rendering ========== */
    async function renderList(q = "", { preserveDetail = true } = {}) {
        const prevScroll = els.list.scrollTop;

        listAbort?.abort();
        listAbort = withAbort();

        let list = [];
        try {
            list = await fetchSessions(listAbort.signal);
        } catch (e) {
            console.error(e);
            els.list.innerHTML = `<li class="sess-item">Erreur de chargement</li>`;
            return;
        }

        const normalized = q.trim().toLowerCase();
        const filt = list.filter((s) => {
            const n = toStr(s?.name ?? "");
            if (filter === "raid" && !/raid/i.test(n)) return false;
            if (filter === "dungeon" && !/(donjon|dungeon)/i.test(n)) return false;
            if (!normalized) return true;
            return n.toLowerCase().includes(normalized);
        });

        if (!filt.length) {
            els.list.innerHTML = `<li class="sess-item">Aucune session</li>`;
            if (!preserveDetail) {
                els.grid.innerHTML = "";
                els.header.textContent = "—";
                els.footer.textContent = "—";
                currentDetailId = null;
            }
            return;
        }

        const itemsHTML = filt.map((s) => {
            const name = toStr(s?.name ?? "Run");
            const kind = /raid/i.test(name) ? "Raid" : (/(donjon|dungeon)/i.test(name) ? "Donjon" : "Run");
            const started = s.startedAt ? DF_INTL.format(new Date(s.startedAt)) : "—";
            const dur = msToClock(s.durationMs ?? (s.endedAt - s.startedAt));
            const size = toNum(s.partySize);

            return `
<li class="sess-item" data-id="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(name)}">
  <div class="sess-card sess-compact">
    <div class="sess-left">
      <div class="sess-avatar-dot" aria-hidden="true"></div>
    </div>

    <div class="sess-mid">
      <div class="sess-title-row">
        <span class="sess-title">${esc(name)}</span>
        <span class="sess-badge badge-${kind.toLowerCase()}">${esc(kind)}</span>
      </div>
      <div class="sess-meta-line">
        <span class="m">${esc(started)}</span>
        <span class="sep">•</span>
        <span class="m">${esc(dur)}</span>
        <span class="sep">•</span>
        <span class="m">${esc(size)} joueur${size > 1 ? "s" : ""}</span>
      </div>
    </div>

    <div class="sess-right">
      <button class="btn-icon sess-del" title="Supprimer" aria-label="Supprimer" tabindex="-1">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 7h12v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7Zm3-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1h5v2H4V5h5Z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</li>`;
        }).join("");

        els.list.innerHTML = itemsHTML;

        // Restaure la sélection précédente
        const idsInDom = Array.from(els.list.children).map(li => li.getAttribute("data-id"));
        // Retire les ids disparus
        for (const id of Array.from(selectedIds)) {
            if (!idsInDom.includes(id)) selectedIds.delete(id);
        }
        // Ré-applique les classes actives
        for (const li of els.list.children) {
            const id = li.getAttribute("data-id");
            if (selectedIds.has(id)) li.classList.add("active");
        }
        // Si aucune sélection (premier rendu), sélectionne la première et affiche le détail
        if (!firstRenderDone && selectedIds.size === 0 && els.list.firstElementChild) {
            const fid = els.list.firstElementChild.getAttribute("data-id");
            if (fid) {
                selectedIds.add(fid);
                els.list.firstElementChild.classList.add("active");
                currentDetailId = fid;
                window.currentDetailId = fid;

                firstRenderDone = true;
                await renderDetail(fid);
            }
        }


        // Restaure le scroll
        els.list.scrollTop = prevScroll;

        // Ne rafraîchis pas le détail pendant l’auto-refresh pour éviter le flash,
        // sauf si l’item affiché a disparu.
        if (!preserveDetail) {
            if (currentDetailId && idsInDom.includes(currentDetailId)) {
                // Optionnel: rafraîchir ici
                // await renderDetail(currentDetailId);
            } else if (selectedIds.size) {
                const firstSel = [...selectedIds][0];
                currentDetailId = firstSel;
                await renderDetail(firstSel);
            }
        }
    }

    function getTop3SpellsFromPlayer(p) {
        const toNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };
        const entry = (id, name, val, kind) => ({
            id,
            name: name || id,
            val: toNum(val),
            kind,
        });

        // 1) Source "officielle" : topAllSpells (faire confiance à kind)
        if (Array.isArray(p?.topAllSpells) && p.topAllSpells.length) {
            return p.topAllSpells
                .slice(0, 3)
                .map((s) => {
                    const val =
                        s.value != null
                            ? toNum(s.value)
                            : Math.max(toNum(s.damage), toNum(s.heal));
                    const k = String(s.kind || "").toLowerCase();
                    const kind = k.startsWith("heal") ? "HPS" : "DPS";
                    return entry(s.id, s.name, val, kind);
                })
                .filter((e) => e.val > 0);
        }

        // 2) Fallback : mix DMG/HEAL explicite
        const mix = [
            ...(p?.topDamageSpells || []).map((s) => entry(s.id, s.name, s.damage, "DPS")),
            ...(p?.topHealSpells || []).map((s) => entry(s.id, s.name, s.heal, "HPS")),
        ]
            .filter((e) => e.val > 0)
            .sort((a, b) => b.val - a.val)
            .slice(0, 3);
        if (mix.length) return mix;

        // 3) Dernier recours : ancien schéma "skills" (tie-break pro-HEAL)
        const skills = p?.skills || p?.snapshot?.skills || p?.skillsByUser || null;
        if (!skills || typeof skills !== "object") return [];

        return Object.entries(skills)
            .map(([id, s]) => {
                const dmg = toNum(s?.totalDamage ?? s?.total_damage);
                const heal = toNum(s?.totalHealing ?? s?.total_healing);
                const val = Math.max(dmg, heal);
                const kind = heal >= dmg ? "HPS" : "DPS";
                return entry(id, s?.displayName || s?.name || id, val, kind);
            })
            .filter((e) => e.val > 0)
            .sort((a, b) => b.val - a.val)
            .slice(0, 3);
    }

    async function renderDetail(id) {
        if (!id) return;

        currentDetailId = id;

        window.currentDetailId = id;

        detailAbort?.abort();
        detailAbort = withAbort();

        const grid = els.grid;
        const prevId = grid.getAttribute("data-session-id");
        const switching = !!(prevId && prevId !== id);

        if (switching) {
            grid.style.opacity = "0";
        } else if (!grid.hasChildNodes()) {
            grid.innerHTML = `<div class="player-card">Chargement…</div>`;
        }

        let sess;
        try {
            sess = await fetchSessionDetail(id, detailAbort.signal);
        } catch (e) {
            console.error(e);
            grid.innerHTML = `<div class="player-card">Erreur de chargement</div>`;
            return;
        }

        const { name, startedAt, durationMs, partySize } = sess ?? {};
        els.header.textContent =
            `${name || "Run"} · Durée: ${msToClock(durationMs)} · Joueurs: ${partySize}`;

        const players = (sess?.snapshot?.players ?? []).slice();
        if (!players.length) {
            grid.innerHTML = `<div class="player-card">Aucune donnée</div>`;
            els.footer.textContent = `Session #${id}`;
            if (els.legacyTbody) els.legacyTbody.innerHTML = `<tr><td colspan="5">Aucune donnée</td></tr>`;
            grid.setAttribute("data-session-id", id);
            if (switching) requestAnimationFrame(() => (grid.style.opacity = "1"));
            return;
        }

        const maxDamage = Math.max(1, ...players.map(p => p?.totals?.damage || 0));
        const maxHeal = Math.max(1, ...players.map(p => p?.totals?.heal || 0));

        players.sort((a, b) => {
            if (sortBy === "name") return (a?.name || "").localeCompare(b?.name || "");
            return (sortKey[sortBy](b) - sortKey[sortBy](a));
        });

        const cardsHTML = players.map((p) => {
            const role = roleFromPlayer(p);
            const clsText = p.class ?? p.className ?? p.playerClass ?? p.profession ?? p.cls ?? "—";
            const ability = p.fightPoint ?? p.fightpoint ?? null;
            const icon = classIconFor(p);
            const classKey = getClassKey(clsText);

            const topArray = getTop3SpellsFromPlayer(p);

            const topHtml = topArray.length
                ? topArray.map(s => `
<li class="spell-line">
  <span class="spell-kind ${s.kind === "DPS" ? "is-dps" : "is-hps"}">
    ${s.kind === "DPS" ? "DMG" : "HEAL"}
  </span>
  <span class="spell-name" title="${esc(s.name)}">${esc(s.name)}</span>
  <span class="spell-val" title="${fmt(s.val)}">${short(s.val)}</span>
</li>`).join("")
                : `
<li class="spell-line">
  <span class="spell-kind">—</span>
  <span class="spell-name">No data</span>
  <span class="spell-val">—</span>
</li>`;

            const dmgRatio = (p?.totals?.damage || 0) / maxDamage;
            const healRatio = (p?.totals?.heal || 0) / maxHeal;

            return `
<article class="player-card pc-optim cc-${classKey}" tabindex="0" aria-label="${esc(p.name)}">
  <header class="pc-header">
    <div class="pc-avatar" data-role="${role}" aria-hidden="true">
      <img class="pc-class-logo" src="${esc(icon)}" alt="" loading="lazy" decoding="async">
    </div>
    <div>
      <div class="pc-name">${esc(p.name)}</div>
      <div class="pc-meta">${fmt(p.dps)} DPS • ${fmt(p.hps)} HPS</div>
      <div class="pc-submeta"><span class="badge cls">${esc(clsText)}</span></div>
    </div>
    <div class="pc-right">
      <div class="${roleClass(p)}">${(p.role || "").toUpperCase() || (role === "heal" ? "HEAL" : "DPS")}</div>
      ${ability != null ? `<div class="pc-ability" title="Ability Score">${fmt(toNum(ability))}</div>` : ``}
    </div>
  </header>

  <div class="pc-bars">
    <div class="meter">
      <label>Damage</label>
      ${barSVG(dmgRatio, "dps")}
      <div class="value" title="${fmt(p?.totals?.damage || 0)}">${short(p?.totals?.damage || 0)}</div>
    </div>
    <div class="meter">
      <label>Healing</label>
      ${barSVG(healRatio, "hps")}
      <div class="value" title="${fmt(p?.totals?.heal || 0)}">${short(p?.totals?.heal || 0)}</div>
    </div>
  </div>

  <div class="pc-tops">
    <div class="tops-title">Top 3 Spells</div>
    <ol class="tops-list">
      ${topHtml}
    </ol>
  </div>
</article>`;
        }).join("");

        // Swap sans flash + fade-in
        requestAnimationFrame(() => {
            grid.innerHTML = cardsHTML;
            grid.setAttribute("data-session-id", id);
            requestAnimationFrame(() => {
                grid.style.opacity = "1";
            });
        });

        els.footer.textContent = `Session #${id}`;

        if (els.legacyTbody) {
            const rows = players.map((p) => {
                const topAll = [
                    ...(p.topDamageSpells || []).map(s => `${esc(s.name)} (${short(s.damage)} DMG)`),
                    ...(p.topHealSpells || []).map(s => `${esc(s.name)} (${short(s.heal ?? 0)} HEAL)`),
                ].filter(Boolean).slice(0, 3).join(", ") || "—";

                const dmgTotal = p?.totals?.damage || 0;
                const healTotal = p?.totals?.heal || 0;

                return `
<tr>
  <td>${esc(p.name)}</td>
  <td class="col-num" title="${fmt(dmgTotal)} dmg • ${fmt(p.dps || 0)} DPS">
    ${short(dmgTotal)} DMG
  </td>
  <td class="col-num" title="${fmt(healTotal)} heal • ${fmt(p.hps || 0)} HPS">
    ${short(healTotal)} HEAL
  </td>
  <td>${topAll}</td>
</tr>`;
            }).join("");

            els.legacyTbody.innerHTML = rows || `<tr><td colspan="5">Aucune donnée</td></tr>`;
        }
    }

    /* ========== Selection helpers ========== */
    const getDomIdsOrder = () => Array.from(els.list.children).map(li => li.getAttribute("data-id"));

    function selectOnly(id) {
        selectedIds.clear();
        if (id) selectedIds.add(id);
        refreshListSelectionClasses();
        anchorId = id;
    }

    function toggleSelect(id) {
        if (!id) return;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        refreshListSelectionClasses();
        anchorId = id;
    }

    function rangeSelect(toId) {
        const order = getDomIdsOrder();
        if (!anchorId || !order.includes(anchorId) || !order.includes(toId)) {
            selectOnly(toId);
            return;
        }
        const a = order.indexOf(anchorId);
        const b = order.indexOf(toId);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        selectedIds.clear();
        for (let i = lo; i <= hi; i++) selectedIds.add(order[i]);
        refreshListSelectionClasses();
    }

    function refreshListSelectionClasses() {
        for (const li of els.list.children) {
            const id = li.getAttribute("data-id");
            li.classList.toggle("active", selectedIds.has(id));
        }
    }

    function showToast(msg = "Copié ✅") {
        const t = $("#shareToast");
        if (!t) return;
        t.textContent = msg;
        t.classList.remove("hidden");
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => {
            t.classList.remove("show");
            setTimeout(() => t.classList.add("hidden"), 220);
        }, 1600);
    }

    async function shareSessionFullCapture() {
        try {
            const region = document.querySelector('.sess-detail-wrap') || document.body;
            const grid = document.getElementById('playersGrid');
            if (!region || !grid) { showToast("Rien à capturer ❌"); return; }

            // 1) Trouver l’ancêtre qui scrolle réellement
            const getScrollParent = (el) => {
                let n = el;
                while (n && n !== document.body) {
                    const st = getComputedStyle(n);
                    const canY = /(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1;
                    if (canY) return n;
                    n = n.parentElement;
                }
                return document.scrollingElement || document.documentElement || document.body;
            };
            const scrollEl = getScrollParent(region);

            // 2) Sauvegarde état/style
            const prev = {
                scrollTop: scrollEl.scrollTop,
                region: {
                    height: region.style.height,
                    maxHeight: region.style.maxHeight,
                    overflow: region.style.overflow,
                },
                grid: {
                    height: grid.style.height,
                    maxHeight: grid.style.maxHeight,
                    overflow: grid.style.overflow,
                },
            };

            // 3) Désactive sticky le temps de la capture (sinon duplication visuelle)
            const stickyKiller = document.createElement('style');
            stickyKiller.textContent = `
      .sess-detail-wrap * { position: static !important; }
      .sess-detail-wrap { overscroll-behavior: contain; }
    `;
            document.head.appendChild(stickyKiller);

            // 4) Déplie: pleine hauteur, plus de scroll (une seule image à capturer)
            scrollEl.scrollTop = 0; // on remonte pour inclure le début
            region.style.height = `${region.scrollHeight}px`;
            region.style.maxHeight = 'none';
            region.style.overflow = 'visible';
            grid.style.height = `${grid.scrollHeight}px`;
            grid.style.maxHeight = 'none';
            grid.style.overflow = 'visible';

            // Laisse le layout se stabiliser (2 RAF = 1 paint complet assuré)
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // 5) Boîte à capturer = toute la zone détail (header + cards)
            const r = region.getBoundingClientRect();
            const bounds = {
                x: Math.round(r.left + window.scrollX),
                y: Math.round(r.top + window.scrollY),
                width: Math.round(r.width),
                height: Math.round(r.height),
            };

            // 6) Capture en un seul appel
            const dataURL = await window.electronAPI?.captureRect?.(bounds);
            if (!dataURL) { showToast("Capture impossible ❌"); return; }

            const ok = await window.electronAPI?.copyImageDataURL?.(dataURL);
            showToast(ok ? "Aperçu copié ✅" : "Échec de la copie ❌");

            // 7) Restaure styles/scroll
            scrollEl.scrollTop = prev.scrollTop;
            region.style.height = prev.region.height;
            region.style.maxHeight = prev.region.maxHeight;
            region.style.overflow = prev.region.overflow;
            grid.style.height = prev.grid.height;
            grid.style.maxHeight = prev.grid.maxHeight;
            grid.style.overflow = prev.grid.overflow;
            stickyKiller.remove();
        } catch (e) {
            console.error('[shareSessionFullCapture] error:', e);
            showToast('Erreur de partage ❌');
        }
    }


    // Garde anti multi-clic pour "+ Enregistrer"
    let isSaving = false;
    async function onSaveClickOnceGuarded() {
        if (isSaving) return;
        isSaving = true;

        const btn = els.saveBtn;
        const prevText = btn?.textContent;
        if (btn) { btn.disabled = true; btn.textContent = "Enregistrement…"; }

        try {
            window.opener?.postMessage?.({ type: "save-session" }, window.location.origin);
            showToast("Sauvegarde demandée…");
        } catch (e) {
            console.error(e);
            showToast("Échec enregistrement ❌");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = prevText ?? "+ Enregistrer"; }
            setTimeout(() => { isSaving = false; }, 500);
        }
    }

    /* ========== Interactions ========== */
    document.addEventListener("DOMContentLoaded", () => {
        // Filtres
        els.segContainer.addEventListener("click", async (e) => {
            const btn = e.target.closest(".seg-btn:not(.sort-btn)");
            if (!btn) return;
            $$(".seg-btn:not(.sort-btn).active").forEach((x) => x.classList.remove("active"));
            btn.classList.add("active");
            filter = btn.dataset.filter || "all";
            await renderList(els.search?.value || "", { preserveDetail: true });
        });

        // Tri
        els.sortContainer.addEventListener("click", (e) => {
            const btn = e.target.closest(".sort-btn");
            if (!btn) return;
            $$(".sort-btn.active").forEach((x) => x.classList.remove("active"));
            btn.classList.add("active");
            sortBy = /** @type any */ (btn.dataset.sort || "damage");
            if (currentDetailId) renderDetail(currentDetailId);
        });

        // Liste: sélection + suppression (délégué unique)
        els.list.addEventListener("click", async (e) => {
            const delBtn = e.target.closest(".sess-del");
            if (delBtn) {
                e.stopPropagation();

                // ID de la carte sur laquelle on a cliqué
                const li = delBtn.closest(".sess-item");
                const clickedId = li?.getAttribute("data-id");

                let ids = [];
                if (selectedIds.size > 1 && selectedIds.has(clickedId)) {
                    ids = [...selectedIds];
                } else if (clickedId) {
                    ids = [clickedId];
                }

                if (!ids.length) return;

                const confirmMsg = ids.length > 1
                    ? `Supprimer ${ids.length} sessions ?`
                    : `Supprimer cette session ?`;
                if (!confirm(confirmMsg)) return;

                await Promise.allSettled(ids.map(deleteSessionById));

                // Ménage dans la sélection et rafraîchit la liste
                const wasShowingDeleted = ids.includes(currentDetailId);
                ids.forEach((id) => selectedIds.delete(id));
                await renderList(els.search?.value || "", { preserveDetail: !wasShowingDeleted });

                // Si on affichait le détail d’un item supprimé, on bascule proprement
                if (wasShowingDeleted) {
                    const firstSel = [...selectedIds][0];
                    if (firstSel) {
                        renderDetail(firstSel);
                    } else {
                        els.grid.innerHTML = "";
                        els.header.textContent = "—";
                        els.footer.textContent = "—";
                        currentDetailId = null;
                    }
                }
                return;
            }

            els.grid.style.transition = "opacity .12s ease";
            els.grid.style.opacity = "1";

            const li = e.target.closest(".sess-item");
            if (!li) return;
            const id = li.getAttribute("data-id");
            const isShift = e.shiftKey;
            const isCtrl = e.ctrlKey || e.metaKey;

            if (isShift) rangeSelect(id);
            else if (isCtrl) toggleSelect(id);
            else selectOnly(id);

            // Ouvre le détail si 1 seul élément est sélectionné
            if (selectedIds.size === 1) {
                const only = [...selectedIds][0];
                if (only !== currentDetailId) renderDetail(only);
            }
        });

        // Clavier: Enter ouvre détail / Delete supprime sélection
        els.list.addEventListener("keydown", async (e) => {
            if (e.key === "Enter") {
                const li = e.target.closest(".sess-item");
                if (!li) return;
                const id = li.getAttribute("data-id");
                if (id) { selectOnly(id); renderDetail(id); }
            }
            if (e.key === "Delete") {
                const ids = [...selectedIds];
                if (!ids.length) return;
                if (!confirm(ids.length > 1 ? `Supprimer ${ids.length} sessions ?` : `Supprimer cette session ?`)) return;

                await Promise.allSettled(ids.map(deleteSessionById));
                const wasShowingDeleted = ids.includes(currentDetailId);
                ids.forEach((id) => selectedIds.delete(id));
                await renderList(els.search?.value || "", { preserveDetail: !wasShowingDeleted });

                if (wasShowingDeleted) {
                    const firstSel = [...selectedIds][0];
                    if (firstSel) renderDetail(firstSel);
                    else {
                        els.grid.innerHTML = "";
                        els.header.textContent = "—";
                        els.footer.textContent = "—";
                        currentDetailId = null;
                    }
                }
            }
        });

        // Recherche
        els.search?.addEventListener("input", throttle(() => {
            renderList(els.search.value, { preserveDetail: true });
        }, 200));

        // Listeners de boutons (attachés une seule fois)
        els.saveBtn?.addEventListener("click", onSaveClickOnceGuarded);
        document.getElementById('btnShare')?.addEventListener('click', async () => {
            try {
                const id = currentDetailId;
                if (!id) { showToast("Aucune session sélectionnée ❌"); return; }
                const ok = await window.Share?.shareById(id, fetchSessionDetail, { sortBy: sortBy });
                showToast(ok ? "Récap copié ✅" : "Copie impossible ❌");
            } catch (e) {
                console.error(e);
                showToast("Erreur de partage ❌");
            }
        });


        els.closeBtn?.addEventListener("click", () => window.close());

        // Auto-refresh sans perturber la vue
        const REFRESH_EVERY_MS = 5000;
        const tick = async () => {
            try { if (!document.hidden) await renderList(els.search?.value || "", { preserveDetail: true }); }
            finally { setTimeout(tick, REFRESH_EVERY_MS); }
        };
        setTimeout(tick, REFRESH_EVERY_MS);

        // Premier rendu
        renderList(els.search?.value || "", { preserveDetail: true });
    });
})();
