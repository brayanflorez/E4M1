// dashboard.js — Tablero en vivo para proyectar en clase: estadísticas y
// gráficos por pregunta, tabla de posiciones, exportación CSV y un informe
// completo descargable (se genera como página imprimible / PDF del navegador).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, onSnapshot, doc, getDocs, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ROUNDS, getRound, computeEarnings } from "./matching-logic.js";
import { computeDecisionFreq, computeWealthDist, computeAcceptanceByOffer } from "./chart-data.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const fmt = (n) => "$" + Number(n).toLocaleString("de-DE");

const MAX_POSSIBLE = ROUNDS.reduce((s, r) => s + r.pot, 0);
const NAVY = "#1f4e78";
const GOLD = "#c8952e";

const roundTabsEl = document.getElementById("roundTabs");
const roundStatsEl = document.getElementById("roundStats");
const leaderboardEl = document.getElementById("leaderboardBody");
const maxPossibleEl = document.getElementById("maxPossible");
maxPossibleEl.textContent = fmt(MAX_POSSIBLE);

let latestPairs = [];
let selectedRound = 1;

// ---------------------------------------------------------------------------
// SVG bar chart — no external library, prints cleanly as vector graphics.
// ---------------------------------------------------------------------------
function svgBarChart({ data, valueKey, color, height = 170, width = 620, formatTop, showN = false, maxOverride }) {
  if (!data || data.length === 0) return `<p class="chart-empty">Todavía no hay datos.</p>`;
  const barW = width / data.length;
  const pad = Math.max(2, barW * 0.14);
  const max = maxOverride ?? Math.max(1, ...data.map((d) => d[valueKey] ?? 0));
  const baseline = height - 24;
  let bars = "";
  data.forEach((d, i) => {
    const val = d[valueKey] ?? 0;
    const h = max > 0 ? (val / max) * (baseline - 14) : 0;
    const x = i * barW + pad;
    const w = barW - pad * 2;
    const y = baseline - h;
    const topLabel = formatTop ? formatTop(d) : String(val);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2"></rect>`;
    if (h > 13) {
      bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#16213b">${topLabel}</text>`;
    }
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(baseline + 13).toFixed(1)}" font-size="9" text-anchor="middle" fill="#4c5c77">${d.label}</text>`;
    if (showN) {
      bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(baseline + 24).toFixed(1)}" font-size="8" text-anchor="middle" fill="#8a95a8">n=${d.n}</text>`;
    }
  });
  bars += `<line x1="0" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="#d8d3c4" stroke-width="1"></line>`;
  return `<svg viewBox="0 0 ${width} ${height}" class="bar-chart-svg">${bars}</svg>`;
}

function chartsForRound(cfg, pairs) {
  const decisionData = computeDecisionFreq(pairs, cfg, fmt);
  const wealthData = computeWealthDist(pairs, cfg, fmt);
  const acceptData = computeAcceptanceByOffer(pairs, cfg, fmt);
  const decisionTitle = cfg.frame === "take" ? "Cuánto decidió tomar quien propuso" : "Cuánto decidió quedarse quien propuso";
  const wealthTitle = "Cómo quedó repartida la riqueza al final (después de aceptar o rechazar)";

  let html = `
    <div class="chart-block">
      <h3>${decisionTitle}</h3>
      ${svgBarChart({ data: decisionData, valueKey: "count", color: NAVY, formatTop: (d) => d.count })}
    </div>`;

  if (acceptData) {
    html += `
      <div class="chart-block">
        <h3>Tasa de aceptación según la oferta recibida</h3>
        <p class="chart-caption">Solo cuenta las ofertas que ya tuvieron respuesta. 'n' es cuántas parejas recibieron exactamente esa oferta — con pocas parejas, una sola respuesta puede mover mucho la barra.</p>
        ${svgBarChart({ data: acceptData.map((d) => ({ ...d, pct: d.rate === null ? 0 : Math.round(d.rate * 100) })), valueKey: "pct", color: NAVY, maxOverride: 100, formatTop: (d) => (d.n ? d.pct + "%" : "—"), showN: true })}
      </div>`;
  }

  html += `
    <div class="chart-block">
      <h3>${wealthTitle}</h3>
      ${svgBarChart({ data: wealthData, valueKey: "count", color: GOLD, formatTop: (d) => d.count })}
    </div>`;

  return html;
}

function renderRoundTabs() {
  roundTabsEl.innerHTML = ROUNDS.map((r) => `
    <button type="button" class="round-tab ${r.id === selectedRound ? "active" : ""}" data-round="${r.id}">
      Pregunta ${r.id}
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
      <div class="stat-card"><div class="num">${pairs.length}</div><div class="lbl">Parejas en esta pregunta</div></div>
      <div class="stat-card"><div class="num">${decided.length}</div><div class="lbl">Decisiones tomadas</div></div>
      <div class="stat-card"><div class="num">${avgDecision === null ? "—" : fmt(Math.round(avgDecision))}</div><div class="lbl">${decisionLabel}</div></div>
      ${acceptHtml}
    </div>
    ${chartsForRound(cfg, pairs)}
  `;
}

function renderLeaderboard() {
  const totals = new Map();
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
  const rows = Array.from(totals.entries()).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.total - a.total);
  leaderboardEl.innerHTML = rows
    .map((r, i) => `
      <tr class="${i === 0 && r.total > 0 ? "leader" : ""}">
        <td>${i + 1}</td><td>${r.name || r.code}</td><td>${r.roundsPlayed} / ${ROUNDS.length}</td><td>${fmt(r.total)}</td>
      </tr>`)
    .join("") || `<tr><td colspan="4" style="text-align:center; color:var(--ink-soft);">Todavía no hay resultados</td></tr>`;
  return rows;
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

// ---------------------------------------------------------------------------
// Reset session
// ---------------------------------------------------------------------------
document.getElementById("btnReset").addEventListener("click", async () => {
  const ok = confirm(
    "Esto borra TODAS las parejas de las 5 preguntas y las filas de espera actuales — úselo solo para " +
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

// ---------------------------------------------------------------------------
// CSV export — one row per student per question (their role, partner, and
// the decision behind that pairing), so it's ready to filter or pivot.
// ---------------------------------------------------------------------------
document.getElementById("btnExport").addEventListener("click", () => {
  const headers = [
    "pregunta", "tipo_pregunta", "monto_pregunta",
    "codigo_estudiante", "nombre_estudiante", "rol",
    "codigo_companero", "nombre_companero",
    "decision_jugador1", "acepto", "mi_ganancia", "ganancia_companero",
    "estado", "pair_id",
  ];
  const rows = [];
  for (const pair of latestPairs) {
    const cfg = getRound(pair.round);
    if (!cfg) continue;
    const e = computeEarnings(pair, cfg);
    const tipo = `${cfg.type === "dictator" ? "Dictador" : "Ultimátum"} (${cfg.frame === "take" ? "quitar" : "dar"})`;
    const acepto = cfg.type !== "ultimatum" ? "N/A" : (pair.accepted === true ? "Sí" : pair.accepted === false ? "No" : "");
    rows.push([pair.round, tipo, cfg.pot, pair.player1Code, pair.player1Name, "Jugador 1 (propone)", pair.player2Code, pair.player2Name, pair.decision ?? "", acepto, e.p1 ?? "", e.p2 ?? "", pair.status, pair.id]);
    rows.push([pair.round, tipo, cfg.pot, pair.player2Code, pair.player2Name, "Jugador 2 (responde)", pair.player1Code, pair.player1Name, pair.decision ?? "", acepto, e.p2 ?? "", e.p1 ?? "", pair.status, pair.id]);
  }
  rows.sort((a, b) => (a[3] > b[3] ? 1 : a[3] < b[3] ? -1 : a[0] - b[0]));
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dg_ug_respuestas_completas_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Informe descargable — arma una página imprimible con las 5 preguntas y la
// tabla de posiciones, y abre el diálogo de impresión del navegador (desde
// ahí se puede elegir "Guardar como PDF").
// ---------------------------------------------------------------------------
function buildReportHTML() {
  const now = new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" });
  let html = `
    <div class="report-header">
      <div class="eyebrow">EXPERIMENTO 4 · INTRODUCCIÓN A LA MICROECONOMÍA</div>
      <h1>Informe — Dictador y Ultimátum</h1>
      <p>Generado el ${now}</p>
    </div>
  `;
  for (const cfg of ROUNDS) {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    const decided = pairs.filter((p) => p.decision !== null && p.decision !== undefined);
    const avgDecision = decided.length ? decided.reduce((s, p) => s + p.decision, 0) / decided.length : null;
    let acceptLine = "";
    if (cfg.type === "ultimatum") {
      const withAccept = pairs.filter((p) => p.accepted === true || p.accepted === false);
      const acceptCount = withAccept.filter((p) => p.accepted === true).length;
      const rate = withAccept.length ? Math.round((acceptCount / withAccept.length) * 100) : null;
      acceptLine = `<span><b>Tasa de aceptación:</b> ${rate === null ? "—" : rate + "%"}</span>`;
    }
    html += `
      <div class="report-question">
        <div class="eyebrow">${cfg.tag}</div>
        <h2>${cfg.title}</h2>
        <p>${cfg.intro}</p>
        <div class="report-stat-line">
          <span><b>Parejas:</b> ${pairs.length}</span>
          <span><b>Decisiones tomadas:</b> ${decided.length}</span>
          <span><b>Promedio:</b> ${avgDecision === null ? "—" : fmt(Math.round(avgDecision))}</span>
          ${acceptLine}
        </div>
        ${chartsForRound(cfg, pairs)}
      </div>
    `;
  }
  const leaderRows = renderLeaderboard(); // also refreshes on-screen table, reused here
  html += `
    <div class="report-question">
      <h2>Tabla de posiciones final</h2>
      <p>Máximo teórico posible en las 5 preguntas: ${fmt(MAX_POSSIBLE)}.</p>
      <table class="report-table">
        <thead><tr><th>#</th><th>Estudiante</th><th>Preguntas jugadas</th><th>Total acumulado</th></tr></thead>
        <tbody>
          ${leaderRows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name || r.code}</td><td>${r.roundsPlayed} / ${ROUNDS.length}</td><td>${fmt(r.total)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
  return html;
}

document.getElementById("btnReport").addEventListener("click", () => {
  document.getElementById("reportContainer").innerHTML = buildReportHTML();
  window.print();
});

render();
