// dashboard.js: Tablero en vivo, estadísticas y gráficos por pregunta,
// pestaña comparativa (Gini y curvas de Lorenz entre las 5 preguntas),
// tabla de posiciones, exportación CSV y un informe completo descargable.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, onSnapshot, doc, getDocs, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ROUNDS, getRound, computeEarnings } from "./matching-logic.js";
import {
  computeDecisionFreq, computeWealthDist, computeAcceptanceByOffer,
  computeEconomySplit, computeGini, computeLorenzPoints,
} from "./chart-data.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const fmt = (n) => "$" + Number(n).toLocaleString("de-DE");

const MAX_POSSIBLE = ROUNDS.reduce((s, r) => s + r.pot, 0);
const NAVY = "#1f4e78";
const GOLD = "#c8952e";
const RED = "#a23b2e";
const SLATE = "#4c5c77";
const TEAL = "#2e8b7d";
const SERIES_COLORS = [NAVY, GOLD, RED, SLATE, TEAL];

const roundTabsEl = document.getElementById("roundTabs");
const roundStatsEl = document.getElementById("roundStats");
const leaderboardEl = document.getElementById("leaderboardBody");
const maxPossibleEl = document.getElementById("maxPossible");
maxPossibleEl.textContent = fmt(MAX_POSSIBLE);

let latestPairs = [];
let selectedView = 1; // 1..5 = pregunta id, "comparativo" = pestaña comparativa

// ---------------------------------------------------------------------------
// SVG chart helpers. No external library, print cleanly as vector graphics.
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
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${d.color || color}" rx="2"></rect>`;
    if (h > 13) {
      bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#16213b">${topLabel}</text>`;
    }
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(baseline + 13).toFixed(1)}" font-size="9" text-anchor="middle" fill="#4c5c77">${d.label}</text>`;
    if (d.sub) bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(baseline + 24).toFixed(1)}" font-size="8" text-anchor="middle" fill="#8a95a8">${d.sub}</text>`;
    if (showN) bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(baseline + (d.sub ? 35 : 24)).toFixed(1)}" font-size="8" text-anchor="middle" fill="#8a95a8">n=${d.n}</text>`;
  });
  bars += `<line x1="0" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="#d8d3c4" stroke-width="1"></line>`;
  return `<svg viewBox="0 0 ${width} ${height}" class="bar-chart-svg">${bars}</svg>`;
}

function svgStackedBar(segments, { width = 620, height = 70 } = {}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total <= 0) return `<p class="chart-empty">Todavía no hay datos.</p>`;
  let x = 0, rects = "", labels = "";
  segments.forEach((seg) => {
    if (seg.value <= 0) return;
    const w = (seg.value / total) * width;
    if (w > 1.5) {
      rects += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height - 26}" fill="${seg.color}"></rect>`;
      if (w > 55) labels += `<text x="${(x + w / 2).toFixed(1)}" y="${(height - 26) / 2 + 5}" font-size="12" fill="#fff" text-anchor="middle" font-weight="600">${Math.round((seg.value / total) * 100)}%</text>`;
      labels += `<text x="${(x + w / 2).toFixed(1)}" y="${height - 8}" font-size="9.5" fill="#4c5c77" text-anchor="middle">${fmt(seg.value)}</text>`;
    }
    x += w;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="bar-chart-svg">${rects}${labels}</svg>`;
}

function svgLorenzMulti(series, { width = 560, height = 430 } = {}) {
  const pad = 44;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2 - 36;
  const toXY = (px, py) => [pad + px * plotW, pad + (1 - py) * plotH];
  let paths = "";
  series.forEach((s, idx) => {
    if (!s.points || s.points.length < 2) return;
    let d = "";
    s.points.forEach((p, i) => { const [x, y] = toXY(p[0], p[1]); d += (i === 0 ? "M " : "L ") + x.toFixed(1) + " " + y.toFixed(1) + " "; });
    paths += `<path d="${d}" fill="none" stroke="${SERIES_COLORS[idx % SERIES_COLORS.length]}" stroke-width="2.2"></path>`;
  });
  const [dx1, dy1] = toXY(0, 0), [dx2, dy2] = toXY(1, 1);
  let legend = "";
  series.forEach((s, idx) => {
    const lx = pad + idx * ((plotW) / series.length), ly = height - 12;
    legend += `<rect x="${lx.toFixed(1)}" y="${(ly - 9).toFixed(1)}" width="10" height="10" fill="${SERIES_COLORS[idx % SERIES_COLORS.length]}"></rect>`;
    legend += `<text x="${(lx + 14).toFixed(1)}" y="${ly}" font-size="10" fill="#4c5c77">P${s.id}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="bar-chart-svg lorenz-svg">
    <line x1="${dx1}" y1="${dy1}" x2="${dx2}" y2="${dy2}" stroke="#d8d3c4" stroke-width="1.5" stroke-dasharray="5,4"></line>
    ${paths}
    <line x1="${pad}" y1="${pad + plotH}" x2="${pad + plotW}" y2="${pad + plotH}" stroke="#16213b"></line>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${pad + plotH}" stroke="#16213b"></line>
    <text x="${pad + plotW / 2}" y="${pad + plotH + 24}" font-size="10.5" text-anchor="middle" fill="#4c5c77">% acumulado de estudiantes</text>
    ${legend}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Per-question chart block
// ---------------------------------------------------------------------------
function chartsForRound(cfg, pairs) {
  const split = computeEconomySplit(pairs, cfg);
  const decisionData = computeDecisionFreq(pairs, cfg, fmt);
  const wealthData = computeWealthDist(pairs, cfg, fmt);
  const acceptData = computeAcceptanceByOffer(pairs, cfg, fmt);
  const decisionTitle = cfg.frame === "take" ? "Cuánto decidió tomar quien propuso" : "Cuánto decidió quedarse quien propuso";

  const segments = [
    { value: split.proponentes, color: NAVY },
    { value: split.respondientes, color: GOLD },
  ];
  if (cfg.type === "ultimatum") segments.push({ value: split.perdido, color: RED });

  let html = `
    <div class="chart-block">
      <h3>Reparto de la economía total de esta pregunta</h3>
      <p class="chart-caption">De ${fmt(split.total)} en juego (parejas ya resueltas), esto es lo que se quedaron quienes proponían, quienes respondían${cfg.type === "ultimatum" ? ", y lo que se perdió por rechazos" : ""}.</p>
      ${svgStackedBar(segments)}
      <div class="chart-legend">
        <span><i style="background:${NAVY}"></i> Proponentes</span>
        <span><i style="background:${GOLD}"></i> Respondientes</span>
        ${cfg.type === "ultimatum" ? `<span><i style="background:${RED}"></i> Perdido por rechazo</span>` : ""}
      </div>
    </div>
    <div class="chart-block">
      <h3>${decisionTitle}</h3>
      ${svgBarChart({ data: decisionData, valueKey: "count", color: NAVY, formatTop: (d) => d.count })}
    </div>`;

  if (acceptData) {
    html += `
      <div class="chart-block">
        <h3>Tasa de aceptación según la oferta recibida</h3>
        <p class="chart-caption">Solo cuenta ofertas ya respondidas. 'n' es cuántas parejas recibieron exactamente esa oferta.</p>
        ${svgBarChart({ data: acceptData.map((d) => ({ ...d, pct: d.rate === null ? 0 : Math.round(d.rate * 100) })), valueKey: "pct", color: NAVY, maxOverride: 100, formatTop: (d) => (d.n ? d.pct + "%" : "-"), showN: true })}
      </div>`;
  }

  html += `
    <div class="chart-block">
      <h3>Cómo quedó repartida la riqueza al final (después de aceptar o rechazar)</h3>
      ${svgBarChart({ data: wealthData, valueKey: "count", color: GOLD, formatTop: (d) => d.count })}
    </div>`;

  return html;
}

// ---------------------------------------------------------------------------
// Tabs (Pregunta 1..5 + Comparativo)
// ---------------------------------------------------------------------------
function renderRoundTabs() {
  const roundBtns = ROUNDS.map((r) => `<button type="button" class="round-tab ${r.id === selectedView ? "active" : ""}" data-view="${r.id}">Pregunta ${r.id}</button>`).join("");
  const compareBtn = `<button type="button" class="round-tab compare-tab ${selectedView === "comparativo" ? "active" : ""}" data-view="comparativo">Comparativo</button>`;
  roundTabsEl.innerHTML = roundBtns + compareBtn;
  roundTabsEl.querySelectorAll(".round-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      selectedView = v === "comparativo" ? "comparativo" : Number(v);
      render();
    });
  });
}

function renderRoundStats() {
  const cfg = getRound(selectedView);
  const pairs = latestPairs.filter((p) => p.round === selectedView);
  const decided = pairs.filter((p) => p.decision !== null && p.decision !== undefined);
  const avgDecision = decided.length ? decided.reduce((s, p) => s + p.decision, 0) / decided.length : null;
  const gini = computeGini(pairs, cfg);

  let acceptHtml = "";
  if (cfg.type === "ultimatum") {
    const withAccept = pairs.filter((p) => p.accepted === true || p.accepted === false);
    const acceptCount = withAccept.filter((p) => p.accepted === true).length;
    const rate = withAccept.length ? Math.round((acceptCount / withAccept.length) * 100) : null;
    acceptHtml = `<div class="stat-card"><div class="num">${rate === null ? "-" : rate + "%"}</div><div class="lbl">Tasa de aceptación</div></div>`;
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
      <div class="stat-card"><div class="num">${avgDecision === null ? "-" : fmt(Math.round(avgDecision))}</div><div class="lbl">${decisionLabel}</div></div>
      ${acceptHtml}
      <div class="stat-card"><div class="num">${gini === null ? "-" : gini.toFixed(2)}</div><div class="lbl">Coeficiente de Gini</div></div>
    </div>
    ${chartsForRound(cfg, pairs)}
  `;
}

function renderComparativoView() {
  const giniData = ROUNDS.map((cfg) => {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    const g = computeGini(pairs, cfg);
    return { label: `P${cfg.id}`, sub: cfg.title, v: g ?? 0, color: SERIES_COLORS[(cfg.id - 1) % SERIES_COLORS.length] };
  });
  const lorenzSeries = ROUNDS.map((cfg) => {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    return { id: cfg.id, points: computeLorenzPoints(pairs, cfg) };
  }).filter((s) => s.points);

  roundStatsEl.innerHTML = `
    <div class="round-banner">
      <div class="eyebrow">COMPARATIVO</div>
      <h2>Desigualdad entre las 5 preguntas</h2>
      <p>Compare cómo cambia el reparto según las reglas de cada pregunta, no por parejas individuales, sino viendo el conjunto del curso.</p>
    </div>
    <div class="chart-block">
      <h3>Coeficiente de Gini por pregunta</h3>
      <p class="chart-caption">0 = reparto perfectamente igual entre todos los estudiantes de esa pregunta. Más alto = más desigual.</p>
      ${svgBarChart({ data: giniData, valueKey: "v", maxOverride: 0.5, formatTop: (d) => d.v.toFixed(2) })}
    </div>
    <div class="chart-block">
      <h3>Curvas de Lorenz: las 5 preguntas superpuestas</h3>
      <p class="chart-caption">Entre más se hunda una curva bajo la línea diagonal (reparto perfectamente igual), más desigual quedó esa pregunta.</p>
      ${lorenzSeries.length ? svgLorenzMulti(lorenzSeries) : '<p class="chart-empty">Todavía no hay datos suficientes.</p>'}
    </div>
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
    .map((r, i) => `<tr class="${i === 0 && r.total > 0 ? "leader" : ""}"><td>${i + 1}</td><td>${r.name || r.code}</td><td>${r.roundsPlayed} / ${ROUNDS.length}</td><td>${fmt(r.total)}</td></tr>`)
    .join("") || `<tr><td colspan="4" style="text-align:center; color:var(--ink-soft);">Todavía no hay resultados</td></tr>`;
  return rows;
}

function render() {
  renderRoundTabs();
  if (selectedView === "comparativo") renderComparativoView();
  else renderRoundStats();
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
    "Esto borra TODAS las parejas de las 5 preguntas y las filas de espera actuales. Úselo solo para " +
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
// CSV export: one row per student per question.
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
// Informe descargable: página imprimible con las 5 preguntas, el comparativo
// de desigualdad, y la tabla de posiciones. Se imprime / guarda como PDF
// desde el diálogo del navegador.
// ---------------------------------------------------------------------------
function buildReportHTML() {
  const now = new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" });
  let html = `
    <div class="report-header">
      <div class="eyebrow">EXPERIMENTO 4 · INTRODUCCIÓN A LA MICROECONOMÍA</div>
      <h1>Informe: Dictador y Ultimátum</h1>
      <p>Generado el ${now}</p>
    </div>
  `;
  for (const cfg of ROUNDS) {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    const decided = pairs.filter((p) => p.decision !== null && p.decision !== undefined);
    const avgDecision = decided.length ? decided.reduce((s, p) => s + p.decision, 0) / decided.length : null;
    const gini = computeGini(pairs, cfg);
    let acceptLine = "";
    if (cfg.type === "ultimatum") {
      const withAccept = pairs.filter((p) => p.accepted === true || p.accepted === false);
      const acceptCount = withAccept.filter((p) => p.accepted === true).length;
      const rate = withAccept.length ? Math.round((acceptCount / withAccept.length) * 100) : null;
      acceptLine = `<span><b>Tasa de aceptación:</b> ${rate === null ? "-" : rate + "%"}</span>`;
    }
    html += `
      <div class="report-question">
        <div class="eyebrow">${cfg.tag}</div>
        <h2>${cfg.title}</h2>
        <p>${cfg.intro}</p>
        <div class="report-stat-line">
          <span><b>Parejas:</b> ${pairs.length}</span>
          <span><b>Decisiones tomadas:</b> ${decided.length}</span>
          <span><b>Promedio:</b> ${avgDecision === null ? "-" : fmt(Math.round(avgDecision))}</span>
          ${acceptLine}
          <span><b>Gini:</b> ${gini === null ? "-" : gini.toFixed(2)}</span>
        </div>
        ${chartsForRound(cfg, pairs)}
      </div>
    `;
  }

  // Comparativo section in the report too
  const giniData = ROUNDS.map((cfg) => {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    const g = computeGini(pairs, cfg);
    return { label: `P${cfg.id}`, sub: cfg.title, v: g ?? 0, color: SERIES_COLORS[(cfg.id - 1) % SERIES_COLORS.length] };
  });
  const lorenzSeries = ROUNDS.map((cfg) => {
    const pairs = latestPairs.filter((p) => p.round === cfg.id);
    return { id: cfg.id, points: computeLorenzPoints(pairs, cfg) };
  }).filter((s) => s.points);
  html += `
    <div class="report-question">
      <div class="eyebrow">COMPARATIVO</div>
      <h2>Desigualdad entre las 5 preguntas</h2>
      <div class="chart-block">
        <h3>Coeficiente de Gini por pregunta</h3>
        ${svgBarChart({ data: giniData, valueKey: "v", maxOverride: 0.5, formatTop: (d) => d.v.toFixed(2) })}
      </div>
      <div class="chart-block">
        <h3>Curvas de Lorenz: las 5 preguntas superpuestas</h3>
        ${lorenzSeries.length ? svgLorenzMulti(lorenzSeries) : '<p class="chart-empty">Sin datos.</p>'}
      </div>
    </div>
  `;

  const leaderRows = renderLeaderboard();
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
