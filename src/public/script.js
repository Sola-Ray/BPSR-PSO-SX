// ============================================================================
// script.js — refactor SOLID-friendly, single-file version
// ============================================================================

(() => {
    "use strict";

    // ==========================================================================
    // 1) Configuration (constantes, clés, options)
    //    SRP: ne contient que la config. OCP: extensible sans toucher au code.
    // ==========================================================================

    /** @typedef {"dps"|"heal"|"tank"} TabKey */

    const CONFIG = Object.freeze({
        SERVER_URL: "localhost:8990",
        WS_RECONNECT_MS: 5000,
        OPEN_SPELLS_IN_WINDOW: true,
        COLOR_HUES: [210, 30, 270, 150, 330, 60, 180, 0, 240],
        NUMERIC_KEYS_WHITELIST: null, // ex: ["totalDamage","totalHits","critHits"]
        SKILL_MERGE_MAP: {
            "1701": ["1702", "1703", "1704", "1739"],
            "1740": ["1741"],
        },
        CLASS_COLORS: {
            wind_knight: "#4aff5a",
            stormblade: "#a155ff",
            frost_mage: "#00b4ff",
            heavy_guardian: "#c08a5c",
            shield_knight: "#f2d05d",
            marksman: "#ff6a00",
            soul_musician: "#ff4a4a",
            verdant_oracle: "#6cff94",
            default: "#999999",
        },
        SPEC_ICONS: {
            wind_knight: { skyward: ["spec_skyward.webp"], vanguard: ["spec_vanguard.webp"], default: ["wind_knight.webp"] },
            stormblade: { iaido: ["spec_slash.webp"], moonstrike: ["spec_moon.webp"], default: ["stormblade.webp"] },
            frost_mage: { icicle: ["spec_icicle.webp"], frostbeam: ["spec_frostbeam.webp"], default: ["frost_mage.webp"] },
            heavy_guardian: { block: ["spec_block.webp"], earthfort: ["spec_earth.webp"], default: ["heavy_guardian.webp"] },
            shield_knight: { shield: ["spec_shield.webp"], recovery: ["spec_recovery.webp"], default: ["shield_knight.webp"] },
            marksman: { wildpack: ["spec_wildpack.webp"], falconry: ["spec_falcon.webp"], default: ["marksman.webp"] },
            soul_musician: { concerto: ["spec_concerto.webp"], dissonance: ["spec_diss.webp"], default: ["soul_musician.webp"] },
            verdant_oracle: { lifebind: ["spec_lifebind.webp"], smite: ["spec_smite.webp"], default: ["verdant_oracle.webp"] },
            default: { default: ["spec_shield.webp"] },
        },
        TABS: { DPS: "dps", HEAL: "heal", TANK: "tank" },
    });

    // ==========================================================================
    // 2) État de l’application
    //    SRP: porte uniquement l’état. DIP: pas de dépendance directe à l’UI ici.
    // ==========================================================================

    const State = {
        activeTab: /** @type {TabKey} */ (CONFIG.TABS.DPS),
        paused: false,
        socket: /** @type {any} */ (null),
        wsConnected: false,
        lastWsMessageTs: Date.now(),
        colorIndex: 0,
        users: /** @type {Record<string, any>} */ ({}),
        skillsByUser: /** @type {Record<string, any>} */ ({}),
        renderPending: false,
        // fenêtre des sorts
        spellWindowRef: /** @type {Window|null} */ (null),
        currentSpellUserId: /** @type {string|null} */ (null),
        spellWindowWatchdog: /** @type {number|null} */ (null),
    };

    // ==========================================================================
    // 3) Utilitaires purs
    //    SRP: fonctions pures & petites. Testables. Aucune dépendance DOM.
    // ==========================================================================

    const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

    function formatNumber(n) {
        if (typeof n !== "number" || Number.isNaN(n)) return "NaN";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return Math.round(n).toString();
    }

    function getClassKey(profession = "") {
        const p = profession.toLowerCase();
        if (p.includes("wind")) return "wind_knight";
        if (p.includes("storm")) return "stormblade";
        if (p.includes("frost")) return "frost_mage";
        if (p.includes("guardian")) return "heavy_guardian";
        if (p.includes("shield")) return "shield_knight";
        if (p.includes("mark")) return "marksman";
        if (p.includes("soul")) return "soul_musician";
        if (p.includes("verdant")) return "verdant_oracle";
        return "default";
    }

    const TabValue = /** OCP: mapping extensible */ {
        [CONFIG.TABS.DPS]: (u) => u.total_damage?.total ?? 0,
        [CONFIG.TABS.HEAL]: (u) => u.total_healing?.total ?? 0,
        [CONFIG.TABS.TANK]: (u) => u.taken_damage ?? 0,
    };

    function valueForTab(u, activeTab) {
        return (TabValue[activeTab] ?? (() => 0))(u);
    }

    function statLine(u, activeTab, percent) {
        const p = percent.toFixed(1);
        switch (activeTab) {
            case CONFIG.TABS.DPS:
                return `${formatNumber(u.total_damage.total)} (${formatNumber(u.total_dps)} DPS, ${p}%)`;
            case CONFIG.TABS.HEAL:
                return `${formatNumber(u.total_healing.total)} (${formatNumber(u.total_hps)} HPS, ${p}%)`;
            case CONFIG.TABS.TANK:
                return `${formatNumber(u.taken_damage)} (${p}%)`;
            default:
                return "";
        }
    }

    // ==========================================================================
    // 4) Fusion des compétences (algorithme pur)
    // ==========================================================================

    /**
     * Merge skills with a mapping of ids to fold.
     * ISP: l’API ne fait que de la fusion.
     */
    function mergeSkills(
        skills,
        mergeMap = CONFIG.SKILL_MERGE_MAP,
        numericKeys = CONFIG.NUMERIC_KEYS_WHITELIST
    ) {
        if (!skills) return {};
        const result = Object.fromEntries(Object.entries(skills).map(([id, d]) => [id, { ...d }]));
        const mergedIds = new Set();

        for (const [mainId, others] of Object.entries(mergeMap)) {
            const group = [mainId, ...others].filter((id) => result[id]);
            if (!group.length) continue;
            if (group.some((id) => mergedIds.has(id))) continue;

            const keepId = result[mainId] ? mainId : group[0];
            const merged = { ...result[keepId] };
            merged.displayName = result[keepId]?.displayName ?? merged.displayName;

            for (const id of group) {
                if (id === keepId) continue;
                const src = result[id];
                if (!src) continue;

                for (const [k, v] of Object.entries(src)) {
                    if (typeof v === "number" && Number.isFinite(v)) {
                        if (numericKeys && !numericKeys.includes(k)) continue;
                        merged[k] = (merged[k] ?? 0) + v;
                    }
                }
            }

            result[keepId] = merged;
            for (const id of group) {
                if (id !== keepId) delete result[id];
                mergedIds.add(id);
            }
        }
        return result;
    }

    // ==========================================================================
    // 5) DOM layer (sélection + helpers)
    //    SRP: tient les références DOM et opérations de base sur le DOM.
    // ==========================================================================

    const $ = (sel) => /** @type {HTMLElement} */(document.querySelector(sel));
    const $$ = (sel) => /** @type {NodeListOf<HTMLElement>} */(document.querySelectorAll(sel));

    const Dom = {
        columns: $("#columnsContainer"),
        settings: $("#settingsContainer"),
        help: $("#helpContainer"),
        passthroughTitle: $("#passthroughTitle"),
        pauseBtn: $("#pauseButton"),
        clearBtn: $("#clearButton"),
        helpBtn: $("#helpButton"),
        settingsBtn: $("#settingsButton"),
        closeBtn: $("#closeButton"),
        opacity: /** @type {HTMLInputElement} */ ($("#opacitySlider")),
        serverStatus: $("#serverStatus"),
        tabButtons: $$(".tab-button"),
        allButtons: [$("#clearButton"), $("#pauseButton"), $("#helpButton"), $("#settingsButton"), $("#closeButton")],
        popup: {
            container: $("#spellPopup"),
            title: $("#popupTitle"),
            list: $("#spellList"),
        },
    };

    function setBackgroundOpacity(v) {
        const val = clamp(Number(v), 0, 1);
        document.documentElement.style.setProperty("--main-bg-opacity", String(val));
    }

    function setServerStatus(status /** "connected"|"disconnected"|"paused"|"reconnecting"|"cleared" */) {
        Dom.serverStatus.className = `status-indicator ${status}`;
    }

    function getServerStatus() {
        return Dom.serverStatus.className.replace("status-indicator ", "");
    }

    // ==========================================================================
    // 6) Rendu liste principale (Renderer)
    //    SRP: produire/mettre à jour la vue. LSP: fonctionne pour toute source users.
    // ==========================================================================

    const Renderer = {
        /** Met à jour l’UI à partir d’un tableau d’utilisateurs. */
        renderDataList(users, activeTab) {
            if (State.renderPending) return;
            State.renderPending = true;

            requestAnimationFrame(() => {
                State.renderPending = false;

                const total = users.reduce((s, u) => s + valueForTab(u, activeTab), 0);
                users.sort((a, b) => valueForTab(b, activeTab) - valueForTab(a, activeTab));

                const top1 = users[0] ? valueForTab(users[0], activeTab) : 0;
                const seen = new Set();

                const prevPos = new Map();
                Array.from(Dom.columns.children).forEach((li) => {
                    prevPos.set(li.dataset.userid, li.getBoundingClientRect().top);
                });

                // CREATE/UPDATE
                for (let i = 0; i < users.length; i++) {
                    const user = users[i];
                    const uid = String(user.id);
                    seen.add(uid);

                    const classKey = getClassKey(user.profession);
                    const baseColor = CONFIG.CLASS_COLORS[classKey] ?? CONFIG.CLASS_COLORS.default;
                    const iconPack = CONFIG.SPEC_ICONS[classKey] || CONFIG.SPEC_ICONS.default;
                    const sub = user.subProfession || "default";
                    const specFiles = iconPack[sub] || iconPack.default || iconPack[Object.keys(iconPack)[0]];

                    const barPercent = top1 ? (valueForTab(user, activeTab) / top1) * 100 : 0;
                    const displayPercent = total ? (valueForTab(user, activeTab) / total) * 100 : 0;
                    const stats = statLine(user, activeTab, displayPercent);
                    const displayName = user.fightPoint ? `${user.name} (${user.fightPoint})` : user.name;

                    let li = Dom.columns.querySelector(`.data-item[data-userid="${uid}"]`);
                    if (!li) {
                        li = document.createElement("li");
                        li.className = `data-item ${classKey}`;
                        li.dataset.userid = uid;
                        li.innerHTML = `
              <div class="main-bar">
                <div class="dps-bar-fill"></div>
                <div class="content">
                  <span class="rank"></span>
                  <span class="spec-icons"></span>
                  <span class="name"></span>
                  <span class="stats"></span>
                  <button class="spell-btn" title="Player Details">
                    <svg viewBox="0 0 24 24" width="14" height="14">
                      <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 
                      6.5 6.5 0 109.5 16c1.61 0 3.09-.59 
                      4.23-1.57l.27.28v.79l5 4.99L20.49 
                      19l-4.99-5zm-6 0C8.01 14 6 11.99 
                      6 9.5S8.01 5 10.5 5 15 7.01 
                      15 9.5 12.99 14 10.5 14z"/>
                    </svg>
                  </button>
                </div>
              </div>
            `;
                        li.querySelector(".spell-btn").addEventListener("click", (e) => {
                            e.stopPropagation();
                            UI.showPopupForUser(uid);
                        });
                        Dom.columns.appendChild(li);
                    } else {
                        li.className = `data-item ${classKey}`;
                    }

                    const fill = li.querySelector(".dps-bar-fill");
                    const rankEl = li.querySelector(".rank");
                    const specIcons = li.querySelector(".spec-icons");
                    const nameEl = li.querySelector(".name");
                    const statsEl = li.querySelector(".stats");

                    rankEl.textContent = `${i + 1}.`;
                    nameEl.textContent = displayName;
                    statsEl.textContent = stats;
                    fill.style.transition = "width 0.3s ease";
                    fill.style.width = `${barPercent}%`;
                    fill.style.background = `linear-gradient(90deg, ${baseColor}, rgba(0,0,0,0.3))`;

                    const currentSrcs = Array.from(specIcons.querySelectorAll("img")).map((img) => img.getAttribute("src"));
                    const desiredSrcs = specFiles.map((f) => `assets/specs/${f}`);
                    if (currentSrcs.join(",") !== desiredSrcs.join(",")) {
                        specIcons.replaceChildren();
                        for (const f of desiredSrcs) {
                            const img = document.createElement("img");
                            img.src = f;
                            img.className = "spec-icon";
                            img.onerror = () => (img.style.display = "none");
                            specIcons.appendChild(img);
                        }
                    }
                }

                // REMOVE ABSENTS
                Array.from(Dom.columns.children).forEach((li) => {
                    const uid = li.dataset.userid;
                    if (!seen.has(uid)) li.remove();
                });

                // REORDER + FLIP animation
                const currentLis = Array.from(Dom.columns.children);
                const desiredOrder = users.map((u) => String(u.id));
                const orderChanged = currentLis.some((li, idx) => li.dataset.userid !== desiredOrder[idx]);

                if (orderChanged) {
                    const frag = document.createDocumentFragment();
                    for (const id of desiredOrder) {
                        const li = Dom.columns.querySelector(`.data-item[data-userid="${id}"]`);
                        if (li) frag.appendChild(li);
                    }
                    Dom.columns.appendChild(frag);
                }

                currentLis.forEach((li) => {
                    const uid = li.dataset.userid;
                    const prevTop = prevPos.get(uid);
                    const newTop = li.getBoundingClientRect().top;
                    if (prevTop != null) {
                        const deltaY = prevTop - newTop;
                        if (Math.abs(deltaY) > 1) {
                            li.style.transition = "none";
                            li.style.transform = `translateY(${deltaY}px)`;
                            requestAnimationFrame(() => {
                                li.style.transition = "transform 0.25s ease";
                                li.style.transform = "";
                                li.addEventListener("transitionend", () => (li.style.pointerEvents = ""), { once: true });
                            });
                        }
                    }
                });
            });
        },
    };

    // ==========================================================================
    // 7) Construction payload “spells” + fenêtre
    //    SRP: tout ce qui concerne l’affichage/transport des détails de sorts.
    //    DIP: n’accède pas directement à io, seulement à window/document fournis.
    // ==========================================================================

    const Spells = {
        buildSpellPayload(userId) {
            const user = State.users[userId];
            const entry = State.skillsByUser[userId];
            console.log(entry);
            if (!user || !entry?.skills) return null;

            const merged = mergeSkills(entry.skills);
            const items = Object.entries(merged)
                .map(([id, d]) => {
                    const damage = d.totalDamage || 0;
                    // ✅ ajoute toutes les sources possibles de "casts"
                    const casts = d.totalCount ?? d.countBreakdown?.total ?? d.totalHits ?? d.hits ?? 0;

                    const hits = casts; // on aligne "hits" sur "casts" pour compat descendante
                    const critHits = d.critCount ?? d.critHits ?? 0;

                    return {
                        id,
                        name: d.displayName || id,
                        type: (d.type || "").toLowerCase(),     // "healing" / "damage"
                        damage,
                        casts,                                   // <<--- NOUVEAU
                        hits,                                    // conservé pour l'ancien details.html
                        critHits,
                        avg: hits > 0 ? damage / hits : 0,
                        critRate: hits > 0 ? (critHits / hits) * 100 : 0,
                        countBreakdown: d.countBreakdown || null // optionnel, utile au debug
                    };
                })
                .filter(x => x.damage > 0);

            const total = items.reduce((s, i) => s + i.damage, 0) || 1;
            const classKey = getClassKey(user.profession);
            return { user, items, total, classKey };
        },

        bringWindowToFront() {
            try { State.spellWindowRef?.focus?.(); } catch { }
            setTimeout(() => { try { State.spellWindowRef?.focus?.(); } catch { } }, 0);
            try { window.focus(); } catch { }
            try { window.electronAPI?.focusChildWindow?.("SpellDetails"); } catch { }
        },

        closeWindowIfAny() {
            try { State.spellWindowRef?.close?.(); } catch { }
            State.spellWindowRef = null;
            State.currentSpellUserId = null;
            if (State.spellWindowWatchdog) { clearInterval(State.spellWindowWatchdog); State.spellWindowWatchdog = null; }
        },

        openWindowForUser(userId) {
            State.currentSpellUserId = userId;

            if (!State.spellWindowRef || State.spellWindowRef.closed) {
                State.spellWindowRef = window.open(
                    "details.html",
                    "SpellDetails",
                    "width=520,height=720,menubar=0,toolbar=0,location=0,status=0,resizable=1"
                );
                State.spellWindowWatchdog = window.setInterval(() => {
                    if (!State.spellWindowRef || State.spellWindowRef.closed) Spells.closeWindowIfAny();
                }, 1000);
            } else {
                Spells.bringWindowToFront();
            }

            const payload = Spells.buildSpellPayload(userId);
            if (!payload) return;

            const send = () => {
                try {
                    State.spellWindowRef.postMessage({ type: "spell-data", payload }, "*");
                } catch {
                    setTimeout(send, 50);
                }
            };
            setTimeout(send, 120);
        },

        pushLiveUpdateIfActive(userId) {
            if (!State.spellWindowRef || State.spellWindowRef.closed) return;
            if (State.currentSpellUserId !== userId) return;
            const payload = Spells.buildSpellPayload(userId);
            if (!payload) return;
            State.spellWindowRef.postMessage({ type: "spell-data", payload }, "*");
        },
    };

    // ==========================================================================
    // 8) Gestion des données (adaptateurs) — SRP: mutation d’état + triggers UI
    // ==========================================================================

    const Data = {
        updateAll() {
            const users = Object.values(State.users).filter((u) =>
                (State.activeTab === CONFIG.TABS.DPS && u.total_dps > 0) ||
                (State.activeTab === CONFIG.TABS.HEAL && u.total_hps > 0) ||
                (State.activeTab === CONFIG.TABS.TANK && u.taken_damage > 0)
            );
            Renderer.renderDataList(users, State.activeTab);
        },

        processDataUpdate(data) {
            if (State.paused || !data?.user) return;

            for (const [userId, newUser] of Object.entries(data.user)) {
                const existing = State.users[userId] ?? {};
                State.users[userId] = {
                    ...existing,
                    ...newUser,
                    id: userId,
                    name: newUser.name && newUser.name !== "未知" ? newUser.name : (existing.name || "..."),
                    profession: newUser.profession || existing.profession || "",
                    fightPoint: newUser.fightPoint ?? existing.fightPoint ?? 0,
                };
            }

            if (data.skills) {
                for (const [userId, skills] of Object.entries(data.skills)) {
                    if (skills) State.skillsByUser[userId] = skills;
                }
            }

            Data.updateAll();

            if (State.currentSpellUserId) {
                const touchedUsers = Object.keys(data.user || {});
                const touchedSkills = Object.keys(data.skills || {});
                if (touchedUsers.includes(State.currentSpellUserId) || touchedSkills.includes(State.currentSpellUserId)) {
                    Spells.pushLiveUpdateIfActive(State.currentSpellUserId);
                }
            }
        },
    };

    // ==========================================================================
    // 9) UI actions (contrôleurs)
    //    SRP: actions utilisateur + orchestration d’autres modules.
    // ==========================================================================

    const UI = {
        togglePause() {
            State.paused = !State.paused;
            Dom.pauseBtn.textContent = State.paused ? "Resume" : "Pause";
            setServerStatus(State.paused ? "paused" : "connected");
        },

        async clearData() {
            try {
                const prev = getServerStatus();
                setServerStatus("cleared");

                const resp = await fetch(`http://${CONFIG.SERVER_URL}/api/clear`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const result = await resp.json();

                if (result.code === 0) {
                    State.users = {};
                    State.skillsByUser = {};
                    Data.updateAll();
                    UI.resetSpellPopup();
                    Spells.closeWindowIfAny();
                    console.log("Data cleared successfully.");
                } else {
                    console.error("Failed to clear data:", result.msg);
                }
                setTimeout(() => setServerStatus(prev), 1000);
            } catch (err) {
                console.error("Clear error:", err);
                setServerStatus("disconnected");
            }
        },

        toggleSettings() {
            const visible = !Dom.settings.classList.contains("hidden");
            Dom.settings.classList.toggle("hidden", visible);
            Dom.columns.classList.toggle("hidden", !visible);
            Dom.help.classList.add("hidden");
        },

        toggleHelp() {
            const visible = !Dom.help.classList.contains("hidden");
            Dom.help.classList.toggle("hidden", visible);
            Dom.columns.classList.toggle("hidden", !visible);
            Dom.settings.classList.add("hidden");
        },

        closeClient() {
            window.electronAPI?.closeClient?.();
        },

        // --- Popup inline (gardé comme fallback “propre”) ---
        resetSpellPopup() {
            Dom.popup.list?.replaceChildren?.();
            const tbody = document.getElementById("spellTbody");
            const summary = document.getElementById("spellSummary");
            const footer = document.getElementById("spellFooter");
            const popupEl = Dom.popup.container;

            if (tbody) tbody.replaceChildren();
            if (summary) summary.replaceChildren();
            Dom.popup.title.textContent = "";
            if (footer) footer.textContent = "—";
            if (popupEl) popupEl.classList.add("hidden");
        },

        showPopupForUser(userId) {
            if (CONFIG.OPEN_SPELLS_IN_WINDOW) {
                const payload = Spells.buildSpellPayload(userId);
                if (!payload) { console.warn("Aucune compétence pour", userId); return; }
                Spells.openWindowForUser(userId);
                return;
            }
            console.warn("Popup inline non utilisé (OPEN_SPELLS_IN_WINDOW=false).");
        },

        closePopup() {
            Dom.popup.container.classList.add("hidden");
        },
    };

    // ==========================================================================
    // 10) WebSocket layer
    //     DIP: dépendance à io() injectée via global window.io disponible.
    // ==========================================================================

    const WS = {
        connect(ioFactory = window.io) {
            State.socket = ioFactory(`ws://${CONFIG.SERVER_URL}`);

            State.socket.on("connect", () => {
                State.wsConnected = true;
                setServerStatus("connected");
                State.lastWsMessageTs = Date.now();
            });

            State.socket.on("disconnect", () => {
                State.wsConnected = false;
                setServerStatus("disconnected");
            });

            State.socket.on("data", (data) => {
                Data.processDataUpdate(data);
                State.lastWsMessageTs = Date.now();
            });

            State.socket.on("user_deleted", ({ uid }) => {
                delete State.users[uid];
                delete State.skillsByUser[uid];
                Data.updateAll();
                if (State.currentSpellUserId === uid) Spells.closeWindowIfAny();
            });

            State.socket.on("connect_error", (err) => {
                console.error("WebSocket error:", err);
                setServerStatus("disconnected");
            });
        },

        checkConnection() {
            const elapsed = Date.now() - State.lastWsMessageTs;

            if (!State.wsConnected && State.socket?.disconnected) {
                setServerStatus("reconnecting");
                State.socket.connect();
            }

            if (elapsed > CONFIG.WS_RECONNECT_MS) {
                State.wsConnected = false;
                State.socket?.disconnect();
                WS.connect();
                setServerStatus("reconnecting");
            }
        },
    };

    // ==========================================================================
    // 11) Bootstrap (composition racine) — orchestre les modules
    // ==========================================================================

    function bootstrap() {
        WS.connect();
        setInterval(WS.checkConnection, CONFIG.WS_RECONNECT_MS);

        Dom.tabButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
                State.activeTab = /** @type {TabKey} */ (btn.dataset.tab);
                Dom.tabButtons.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                Data.updateAll();
            });
        });

        Dom.opacity.addEventListener("input", (e) => setBackgroundOpacity(e.target.value));
        setBackgroundOpacity(Dom.opacity.value);

        // Electron passthrough
        window.electronAPI?.onTogglePassthrough?.((isIgnoring) => {
            Dom.allButtons.forEach((btn) => btn.classList.toggle("hidden", isIgnoring));
            Dom.passthroughTitle.classList.toggle("hidden", !isIgnoring);
            Dom.columns.classList.remove("hidden");
            Dom.settings.classList.add("hidden");
            Dom.help.classList.add("hidden");
        });

        document.getElementById("closePopupButton")?.addEventListener("click", UI.closePopup);
    }

    document.addEventListener("DOMContentLoaded", bootstrap);

    // ==========================================================================
    // 12) API publique (facilite les tests / interactions externes)
    // ==========================================================================

    Object.assign(window, {
        clearData: UI.clearData,
        togglePause: UI.togglePause,
        toggleSettings: UI.toggleSettings,
        toggleHelp: UI.toggleHelp,
        closeClient: UI.closeClient,
        showPopupForUser: UI.showPopupForUser,
        closePopup: UI.closePopup,
    });
})();
