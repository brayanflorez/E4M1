// dashboard.js — Tablero en vivo para proyectar en clase (5 rondas + tabla de posiciones).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, onSnapshot, doc, getDocs, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ROUNDS, getRound, computeEarnings } from "./matching-logic.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const fmt = (n) => "$" + Number(n).toLocaleString("de-DE");

const MAX_POSSIBLE = ROUNDS.reduce((s, r) => s + r.pot, 0);

const roundTabsEl = document.getElementById("roundTabs");
const roundStatsEl = document.getElementById("roundStats");
const leaderboardEl = document.getElementById("leaderboardBody");
const maxPossibleEl = document.getElementById("maxPossible");
maxPossibleEl.textContent = fmt(MAX_POSSIBLE);

let latestPairs = [];
let selectedRound = 1;

function renderRoundTabs() {
  roundTabsEl.innerHTML = ROUNDS.map((r) => `
    <button type="button" class="round-tab ${r.id === selectedRound ? "active" : ""}" data-round="${r.id}">
      Ronda ${r.id}
    </button>`).join("");
  roundTabsEl.querySelectorAll(".round-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRound = Number(btn.dataset.round);
      render();
    });
  });
}

function renderRoundStats() {
  const cfg = getRound(selectedRound);
  const pairs = latestPairs.filter((p) => p.round === selectedRound);
  const decided = pairs.filter((p) => p.decision !== null && p.decision !== undefined);
  const avgDecision = decided.length ? decided.reduce((s, p) => s + p.decision, 0) / decided.length : null;

  let acceptHtml = "";
  if (cfg.type === "ultimatum") {
    const withAccept = pairs.filter((p) => p.accepted === true || p.accepted === false);
    const acceptCount = withAccept.filter((p) => p.accepted === true).length;
    const rate = withAccept.length ? Math.round((acceptCount / withAccept.length) * 100) : null;
    acceptHtml = `<div class="stat-card"><div class="num">${rate === null ? "—" : rate + "%"}</div><div class="lbl">Tasa de aceptación</div></div>`;
  }

  const decisionLabel = cfg.frame === "take" ? "Promedio que se TOMÓ" : "Promedio que se quedó el proponente";

  roundStatsEl.innerHTML = `
    <div class="round-banner">
      <div class="eyebrow">${cfg.tag}</div>
      <h2>${cfg.title}</h2>
      <p>${cfg.intro}</p>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${pairs.length}</div><div class="lbl">Parejas en esta ronda</div></div>
      <div class="stat-card"><div class="num">${decided.length}</div><div class="lbl">Decisiones tomadas</div></div>
      <div class="stat-card"><div class="num">${avgDecision === null ? "—" : fmt(Math.round(avgDecision))}</div><div class="lbl">${decisionLabel}</div></div>
      ${acceptHtml}
    </div>
  `;
}

function renderLeaderboard() {
  const totals = new Map(); // code -> {name, total, roundsPlayed}
  for (const p of latestPairs) {
    const cfg = getRound(p.round);
    if (!cfg) continue;
    const e = computeEarnings(p, cfg);
    for (const [code, name, amount] of [[p.player1Code, p.player1Name, e.p1], [p.player2Code, p.player2Name, e.p2]]) {
      if (amount === null || amount === undefined) continue;
      if (!totals.has(code)) totals.set(code, { name, total: 0, roundsPlayed: 0 });
      const entry = totals.get(code);
      entry.total += amount;
      entry.roundsPlayed += 1;
    }
  }
  const rows = Array.from(totals.entries())
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.total - a.total);

  leaderboardEl.innerHTML = rows
    .map((r, i) => `
      <tr class="${i === 0 && r.total > 0 ? "leader" : ""}">
        <td>${i + 1}</td>
        <td>${r.name || r.code}</td>
        <td>${r.roundsPlayed} / ${ROUNDS.length}</td>
        <td>${fmt(r.total)}</td>
      </tr>`)
    .join("") || `<tr><td colspan="4" style="text-align:center; color:var(--ink-soft);">Todavía no hay resultados</td></tr>`;
}

function render() {
  renderRoundTabs();
  renderRoundStats();
  renderLeaderboard();
}

onSnapshot(collection(db, "pairs"), (snap) => {
  latestPairs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
});

// ---- Reset session ----
document.getElementById("btnReset").addEventListener("click", async () => {
  const ok = confirm(
    "Esto borra TODAS las parejas de las 5 rondas y las filas de espera actuales — úselo solo para " +
    "empezar una sesión nueva (otro grupo o semestre). ¿Continuar?"
  );
  if (!ok) return;
  const pairsSnap = await getDocs(collection(db, "pairs"));
  const batch = writeBatch(db);
  pairsSnap.docs.forEach((d) => batch.delete(d.ref));
  for (const r of ROUNDS) {
    batch.set(doc(db, "state", `queue_r${r.id}`), { waitingCode: null, waitingName: null, waitingSince: null });
  }
  await batch.commit();
});

// ---- CSV export ----
document.getElementById("btnExport").addEventListener("click", () => {
  const headers = ["round", "pair_id", "player1_code", "player1_name", "player2_code", "player2_name", "decision", "accepted", "status", "player1_earn", "player2_earn"];
  const rows = latestPairs.map((p) => {
    const cfg = getRound(p.round);
    const e = cfg ? computeEarnings(p, cfg) : { p1: "", p2: "" };
    return [
      p.round, p.id, p.player1Code, p.player1Name, p.player2Code, p.player2Name,
      p.decision ?? "", p.accepted === true ? 1 : p.accepted === false ? 0 : "", p.status,
      e.p1 ?? "", e.p2 ?? "",
    ];
  });
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dg_ug_resultados_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

render();
