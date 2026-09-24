// app.js — Dictador y Ultimátum: serie de 5 rondas, app en vivo para estudiantes.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, doc, collection, updateDoc, onSnapshot, query, where,
  runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  ROUNDS, getRound, joinQueue, listenForMyPair, submitDecision, submitAccept,
  listenToPair, computeEarnings, myRole,
} from "./matching-logic.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const fx = { db, doc, collection, updateDoc, onSnapshot, query, where, runTransaction, serverTimestamp };

const fmt = (n) => "$" + Number(n).toLocaleString("de-DE");
const root = document.getElementById("app");
function render(html) { root.innerHTML = html; }

// ---- Persisted identity/progress so a refresh doesn't lose the session ----
let myCode = sessionStorage.getItem("dgug_code") || null;
let myName = sessionStorage.getItem("dgug_name") || null;
let currentRoundId = Number(sessionStorage.getItem("dgug_round") || 1);
let currentPairId = sessionStorage.getItem("dgug_pairId") || null;
let phase = sessionStorage.getItem("dgug_phase") || "join"; // join | title | matching | final
let history = JSON.parse(sessionStorage.getItem("dgug_history") || "[]"); // [{round, amount}]

let unsubPair = null;

function saveProgress() {
  sessionStorage.setItem("dgug_round", String(currentRoundId));
  sessionStorage.setItem("dgug_phase", phase);
  if (currentPairId) sessionStorage.setItem("dgug_pairId", currentPairId);
  else sessionStorage.removeItem("dgug_pairId");
  sessionStorage.setItem("dgug_history", JSON.stringify(history));
}

// ---------------------------------------------------------------------------
// Amount picker (shared by give- and take-frame decision screens)
// ---------------------------------------------------------------------------
function amountOptions(pot, frame) {
  const max = frame === "take" ? pot / 2 : pot;
  const step = max / 10;
  const topLabel = frame === "take" ? "Le quita" : "Se queda con";
  const bottomLabel = frame === "take" ? "A su compañero le queda" : "Su compañero recibe";
  let html = '<div class="amount-grid" id="amountGrid">';
  for (let i = 0; i <= 10; i++) {
    const v = Math.round(i * step);
    const other = frame === "take" ? (pot / 2 - v) : (pot - v);
    html += `<button type="button" class="amount-option" data-v="${v}">
        <span class="opt-label">${topLabel}</span>
        <span class="big">${fmt(v)}</span>
        <span class="small">${bottomLabel}: ${fmt(other)}</span>
      </button>`;
  }
  html += "</div>";
  return html;
}
function wireAmountGrid(onPick) {
  const grid = document.getElementById("amountGrid");
  grid.querySelectorAll(".amount-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      grid.querySelectorAll(".amount-option").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      onPick(Number(btn.dataset.v));
    });
  });
}

// ---------------------------------------------------------------------------
// SCREEN: join (round 1 only)
// ---------------------------------------------------------------------------
function screenJoin(isReplay) {
  render(`
    <div class="ticket">
      <div class="eyebrow">EXPERIMENTO · MICROECONOMÍA</div>
      <h1>Dictador y Ultimátum</h1>
      <p>Va a jugar <b>5 rondas</b> de reparto de dinero experimental, cada una con un compañero anónimo distinto y reglas que van cambiando. Al final del curso, quien más pesos experimentales acumule gana el equivalente en pesos reales.</p>
      <div class="field">
        <label for="inName">Nombre completo</label>
        <input id="inName" type="text" autocomplete="name" placeholder="Ej. María Torres" />
      </div>
      <div class="field">
        <label for="inCode">Código estudiantil</label>
        <input id="inCode" type="text" inputmode="numeric" placeholder="Ej. 202512345" />
      </div>
      ${isReplay ? '<p style="font-size:0.82rem; margin-top:-8px;">Si su profesor le pidió jugar otra vez, agregue <b>-2</b> al final de su código (ej. 202512345-2).</p>' : ""}
      <div class="err" id="joinErr" style="display:none"></div>
      <button class="btn btn-primary" id="btnJoin">Comenzar</button>
    </div>
    <p class="footer-note">Sus respuestas son anónimas para el resto del curso. Nadie sabrá con quién quedó emparejado en cada ronda.</p>
  `);
  document.getElementById("btnJoin").addEventListener("click", () => {
    const name = document.getElementById("inName").value.trim();
    const code = document.getElementById("inCode").value.trim();
    const errEl = document.getElementById("joinErr");
    if (!name || !code) {
      errEl.textContent = "Por favor escriba su nombre y su código.";
      errEl.style.display = "block";
      return;
    }
    myCode = code; myName = name;
    sessionStorage.setItem("dgug_code", code);
    sessionStorage.setItem("dgug_name", name);
    currentRoundId = 1;
    history = [];
    phase = "title";
    saveProgress();
    screenRoundTitle(getRound(1));
  });
}

// ---------------------------------------------------------------------------
// SCREEN: round title card (narrative beat before each round)
// ---------------------------------------------------------------------------
function screenRoundTitle(cfg) {
  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag}</div>
      <h1>${cfg.title}</h1>
      <p>${cfg.intro}</p>
      <button class="btn btn-primary" id="btnStartRound">Buscar pareja</button>
    </div>
  `);
  document.getElementById("btnStartRound").addEventListener("click", async () => {
    const btn = document.getElementById("btnStartRound");
    btn.disabled = true; btn.textContent = "Buscando...";
    phase = "matching";
    saveProgress();
    try {
      const immediate = await joinQueue(fx, { code: myCode, name: myName, round: cfg.id });
      if (immediate) {
        attachToPair(immediate.pairId);
      } else {
        screenWaitingForPartner();
        listenForMyPair(fx, { code: myCode, round: cfg.id }, (pairId) => attachToPair(pairId));
      }
    } catch (e) {
      console.error(e);
      btn.disabled = false; btn.textContent = "Buscar pareja";
    }
  });
}

function screenWaitingForPartner() {
  render(`
    <div class="ticket">
      <div class="eyebrow">${getRound(currentRoundId).tag}</div>
      <h1>Buscando pareja...</h1>
      <div class="status-line"><span class="pulse"></span> Esperando a que otro estudiante entre a esta ronda</div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Pair listener wiring
// ---------------------------------------------------------------------------
function attachToPair(pairId) {
  currentPairId = pairId;
  phase = "playing";
  saveProgress();
  if (unsubPair) unsubPair();
  unsubPair = listenToPair(fx, pairId, (pair) => driveScreen(pair));
}

function driveScreen(pair) {
  const cfg = getRound(currentRoundId);
  const role = myRole(pair, myCode);
  if (!role) return;

  const decided = pair.decision !== null && pair.decision !== undefined;
  const resolved = cfg.type === "ultimatum"
    ? (pair.accepted !== null && pair.accepted !== undefined)
    : decided;

  if (role === "player1") {
    if (!decided) screenDecide(pair, cfg, "player1");
    else if (cfg.type === "ultimatum" && !resolved) screenWaitingResponse(pair, cfg);
    else screenRoundResult(pair, cfg, "player1");
  } else {
    if (!decided) screenWaitPartnerDecision(cfg);
    else if (cfg.type === "ultimatum" && !resolved) screenDecideAccept(pair, cfg);
    else screenRoundResult(pair, cfg, "player2");
  }
}

// ---------------------------------------------------------------------------
// SCREEN: Player 1 decides (give or take frame, with optional earned-quiz gate)
// ---------------------------------------------------------------------------
function screenDecide(pair, cfg, role) {
  if (cfg.earned && !sessionStorage.getItem(`dgug_quizpass_r${cfg.id}`)) {
    screenQuiz(cfg, () => {
      sessionStorage.setItem(`dgug_quizpass_r${cfg.id}`, "1");
      screenDecide(pair, cfg, role);
    });
    return;
  }

  const question = cfg.frame === "take"
    ? `¿Cuánto le quita a su compañero?`
    : `¿Cómo reparte ${fmt(cfg.pot)}?`;

  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag} · USTED DECIDE</div>
      <h1>${question}</h1>
      <p>${cfg.type === "ultimatum" ? "Recuerde: su compañero puede rechazar esta oferta." : "Su compañero no tiene ninguna decisión que tomar en esta ronda."}</p>
      ${amountOptions(cfg.pot, cfg.frame)}
      <button class="btn btn-primary" id="btnSubmit" disabled>${cfg.type === "ultimatum" ? "Enviar oferta" : "Confirmar decisión"}</button>
    </div>
  `);
  let selected = null;
  wireAmountGrid((v) => { selected = v; document.getElementById("btnSubmit").disabled = false; });
  document.getElementById("btnSubmit").addEventListener("click", async () => {
    document.getElementById("btnSubmit").disabled = true;
    document.getElementById("btnSubmit").textContent = "Enviando...";
    await submitDecision(fx, currentPairId, selected, cfg.type);
  });
}

// ---------------------------------------------------------------------------
// SCREEN: earned-money quiz gate (Round 4)
// ---------------------------------------------------------------------------
function screenQuiz(cfg, onPass) {
  let qi = 0;
  function renderQuestion() {
    const item = cfg.quiz[qi];
    render(`
      <div class="ticket">
        <div class="eyebrow">${cfg.tag} · GÁNESE EL DINERO</div>
        <h1>Pregunta ${qi + 1} de ${cfg.quiz.length}</h1>
        <p>${item.q}</p>
        <div id="quizOptions"></div>
        <div class="err" id="quizErr" style="display:none">Esa no es la respuesta correcta. Intente de nuevo.</div>
      </div>
    `);
    const optsEl = document.getElementById("quizOptions");
    item.options.forEach((opt, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-secondary";
      b.style.marginBottom = "10px";
      b.textContent = opt;
      b.addEventListener("click", () => {
        if (idx === item.correct) {
          qi += 1;
          if (qi >= cfg.quiz.length) onPass();
          else renderQuestion();
        } else {
          document.getElementById("quizErr").style.display = "block";
        }
      });
      optsEl.appendChild(b);
    });
  }
  renderQuestion();
}

// ---------------------------------------------------------------------------
// SCREEN: Player 1 waiting for a response (ultimatum only)
// ---------------------------------------------------------------------------
function screenWaitingResponse(pair, cfg) {
  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag}</div>
      <h1>Esperando respuesta...</h1>
      <div class="status-line"><span class="pulse"></span> Su compañero está decidiendo si acepta su oferta</div>
      <hr class="divider" />
      <div class="receipt-row"><span class="label">Su oferta</span><span class="value">${fmt(pair.decision)} para usted</span></div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// SCREEN: Player 2 waiting for Player 1's decision
// ---------------------------------------------------------------------------
function screenWaitPartnerDecision(cfg) {
  const msg = cfg.earned
    ? "Su compañero está respondiendo unas preguntas para ganarse el dinero de esta ronda"
    : "Su compañero está decidiendo cómo repartir el dinero";
  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag}</div>
      <h1>Esperando a su compañero...</h1>
      <div class="status-line"><span class="pulse"></span> ${msg}</div>
      <p>${cfg.type === "ultimatum" ? "En un momento le va a llegar una oferta real que usted podrá aceptar o rechazar." : "En esta ronda usted no toma ninguna decisión — solo recibe el resultado."}</p>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// SCREEN: Player 2 decides accept/reject (ultimatum only)
// ---------------------------------------------------------------------------
function screenDecideAccept(pair, cfg) {
  const theyKeep = pair.decision;
  const youGet = cfg.pot - theyKeep;
  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag} · LE LLEGÓ UNA OFERTA</div>
      <h1>Su compañero le ofrece ${fmt(youGet)}</h1>
      <p>Su compañero se queda con ${fmt(theyKeep)} de ${fmt(cfg.pot)} y le ofrece ${fmt(youGet)} a usted. Si ACEPTA, el dinero se reparte así. Si RECHAZA, los dos se quedan con $0.</p>
      <button class="btn btn-accept" id="btnAccept" style="margin-bottom:10px;">Aceptar la oferta</button>
      <button class="btn btn-reject" id="btnReject">Rechazar la oferta</button>
    </div>
  `);
  document.getElementById("btnAccept").addEventListener("click", async () => {
    document.getElementById("btnAccept").disabled = true;
    document.getElementById("btnReject").disabled = true;
    await submitAccept(fx, currentPairId, true);
  });
  document.getElementById("btnReject").addEventListener("click", async () => {
    document.getElementById("btnAccept").disabled = true;
    document.getElementById("btnReject").disabled = true;
    await submitAccept(fx, currentPairId, false);
  });
}

// ---------------------------------------------------------------------------
// SCREEN: round result (then advance to next round, or final summary)
// ---------------------------------------------------------------------------
function screenRoundResult(pair, cfg, role) {
  const e = computeEarnings(pair, cfg);
  const mine = role === "player1" ? e.p1 : e.p2;

  if (!history.find((h) => h.round === cfg.id)) {
    history.push({ round: cfg.id, title: cfg.title, amount: mine });
    saveProgress();
  }
  const runningTotal = history.reduce((s, h) => s + h.amount, 0);

  const rejected = cfg.type === "ultimatum" && pair.accepted === false;
  const isLastRound = cfg.id === ROUNDS.length;

  render(`
    <div class="ticket">
      <div class="eyebrow">${cfg.tag} · RESULTADO</div>
      <h1>${rejected ? "Oferta rechazada" : "Ronda completa"}</h1>
      <hr class="divider" />
      <div class="receipt-row total"><span class="label">Usted gana en esta ronda</span><span class="value">${fmt(mine)}</span></div>
      <hr class="divider" />
      <div class="receipt-row"><span class="label">Acumulado (${history.length} de ${ROUNDS.length} rondas)</span><span class="value">${fmt(runningTotal)}</span></div>
      ${isLastRound
        ? `<button class="btn btn-primary" id="btnNext" style="margin-top:16px;">Ver resultado final</button>`
        : `<p style="margin-top:16px;">${cfg.teaserNext || ""}</p><button class="btn btn-primary" id="btnNext">Continuar a la Ronda ${cfg.id + 1}</button>`
      }
    </div>
  `);
  document.getElementById("btnNext").addEventListener("click", () => {
    if (unsubPair) { unsubPair(); unsubPair = null; }
    currentPairId = null;
    if (isLastRound) {
      phase = "final";
      saveProgress();
      screenFinalSummary();
    } else {
      currentRoundId = cfg.id + 1;
      phase = "title";
      saveProgress();
      screenRoundTitle(getRound(currentRoundId));
    }
  });
}

// ---------------------------------------------------------------------------
// SCREEN: final summary across all 5 rounds
// ---------------------------------------------------------------------------
function screenFinalSummary() {
  const total = history.reduce((s, h) => s + h.amount, 0);
  const rows = history
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((h) => `<div class="receipt-row"><span class="label">Ronda ${h.round} — ${h.title}</span><span class="value">${fmt(h.amount)}</span></div>`)
    .join("");
  render(`
    <div class="ticket">
      <div class="eyebrow">RESULTADO FINAL · 5 RONDAS</div>
      <h1>Su recibo completo</h1>
      <hr class="divider" />
      ${rows}
      <hr class="divider" />
      <div class="receipt-row total"><span class="label">Total acumulado</span><span class="value">${fmt(total)}</span></div>
    </div>
    <p class="footer-note">Gracias por participar. Quien acumule más pesos experimentales en todo el curso recibe el equivalente en pesos reales (hasta $20.000). Su profesor va a mostrar la tabla de resultados de todo el curso en un momento.</p>
    <button class="btn btn-secondary" id="btnReplay" style="max-width:420px; margin-top:14px;">Jugar otra vez</button>
  `);
  document.getElementById("btnReplay").addEventListener("click", () => {
    ["dgug_code", "dgug_name", "dgug_round", "dgug_pairId", "dgug_phase", "dgug_history"].forEach((k) => sessionStorage.removeItem(k));
    for (const r of ROUNDS) sessionStorage.removeItem(`dgug_quizpass_r${r.id}`);
    myCode = null; myName = null; currentRoundId = 1; currentPairId = null; phase = "join"; history = [];
    screenJoin(true);
  });
}

// ---------------------------------------------------------------------------
// Boot — resumes correctly no matter where a refresh catches the student.
// ---------------------------------------------------------------------------
if (phase === "final") {
  screenFinalSummary();
} else if (currentPairId) {
  attachToPair(currentPairId);
} else if (phase === "matching" && myCode) {
  screenWaitingForPartner();
  listenForMyPair(fx, { code: myCode, round: currentRoundId }, (pairId) => attachToPair(pairId));
} else if (myCode && myName) {
  screenRoundTitle(getRound(currentRoundId));
} else {
  screenJoin();
}
