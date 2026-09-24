// matching-logic.js
// Round-aware matching + game logic, written against the Firestore v9 modular
// API surface (works against real Firebase or the in-memory mock in tests).

// ---------------------------------------------------------------------------
// ROUND CONFIGURATION — the whole "story" of the session lives here. Change
// wording, pots, or add/remove rounds by editing this array; everything else
// (matching, earnings, UI) adapts automatically.
// ---------------------------------------------------------------------------
export const ROUNDS = [
  {
    id: 1,
    tag: "Ronda 1 · Dictador",
    title: "El reparto libre",
    pot: 3000,
    type: "dictator",   // "dictator" | "ultimatum"
    frame: "give",       // "give" | "take"
    earned: false,
    intro: "Usted tiene $3.000 pesos experimentales para repartir con un compañero anónimo del curso. Decide cuánto se queda y cuánto le envía. Su compañero no tiene ningún voto: recibe lo que usted decida.",
    teaserNext: "Ronda 2: esta vez su compañero sí va a poder responder a su oferta...",
  },
  {
    id: 2,
    tag: "Ronda 2 · Ultimátum",
    title: "La última palabra",
    pot: 3000,
    type: "ultimatum",
    frame: "give",
    earned: false,
    intro: "De nuevo hay $3.000 para repartir. Usted propone el reparto, pero esta vez su compañero puede ACEPTAR o RECHAZAR su oferta. Si la rechaza, los dos se quedan con $0.",
    teaserNext: "Ronda 3: el dinero ya no es un regalo — parte de él ya es de su compañero...",
  },
  {
    id: 3,
    tag: "Ronda 3 · Dictador (marco de quitar)",
    title: "Lo que ya es suyo",
    pot: 3000,
    type: "dictator",
    frame: "take",
    earned: false,
    intro: "Usted y su compañero ya tienen $1.500 pesos experimentales guardados cada uno. Usted decide cuánto le QUITA del bolsillo a su compañero — entre $0 y $1.500. Su compañero no tiene ningún voto.",
    teaserNext: "Ronda 4: esta vez el dinero no es gratis — hay que ganárselo primero...",
  },
  {
    id: 4,
    tag: "Ronda 4 · Dictador (dinero ganado)",
    title: "Dinero ganado",
    pot: 3000,
    type: "dictator",
    frame: "give",
    earned: true,
    intro: "Esta vez el dinero no cae del cielo: antes de repartir, tiene que ganárselo respondiendo dos preguntas rápidas. Una vez las conteste, va a repartir $3.000 con su compañero, igual que en la Ronda 1.",
    teaserNext: "Última ronda: se triplica el monto en juego...",
    quiz: [
      { q: "Si el precio de un producto sube y la cantidad demandada baja, la curva de demanda tiene pendiente...", options: ["Negativa", "Positiva", "Vertical"], correct: 0 },
      { q: "El costo de oportunidad de una decisión es...", options: ["Lo que se pagó en dinero", "El valor de la mejor alternativa a la que se renuncia", "El impuesto sobre la decisión"], correct: 1 },
    ],
  },
  {
    id: 5,
    tag: "Ronda 5 · Ultimátum (apuesta alta)",
    title: "Sube la apuesta",
    pot: 8000,
    type: "ultimatum",
    frame: "give",
    earned: false,
    intro: "Última ronda, y esta vez hay $8.000 en juego — más del doble que antes. Usted propone el reparto y su compañero decide si lo acepta o lo rechaza. Si lo rechaza, los dos pierden todo.",
    teaserNext: null,
  },
];

export function getRound(id) {
  return ROUNDS.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Attempts to join the matching queue for a given round. If someone is
 * already waiting for that same round, pairs immediately. Otherwise this
 * player becomes the waiting player for that round's queue.
 */
export async function joinQueue(fx, { code, name, round }) {
  const { doc, collection, runTransaction, serverTimestamp } = fx;
  const queueRef = doc(fx.db, "state", `queue_r${round}`);
  const pairsCol = collection(fx.db, "pairs");

  let result = null;

  await runTransaction(fx.db, async (tx) => {
    const queueSnap = await tx.get(queueRef);
    const data = queueSnap.exists() ? queueSnap.data() : {};

    if (data.waitingCode && data.waitingCode !== code) {
      const newPairRef = doc(pairsCol);
      const iAmPlayer1 = Math.random() < 0.5;
      const player1 = iAmPlayer1 ? { code, name } : { code: data.waitingCode, name: data.waitingName };
      const player2 = iAmPlayer1 ? { code: data.waitingCode, name: data.waitingName } : { code, name };

      tx.set(newPairRef, {
        round,
        player1Code: player1.code,
        player1Name: player1.name,
        player2Code: player2.code,
        player2Name: player2.name,
        playerCodes: [player1.code, player2.code],
        decision: null,
        accepted: null,
        status: "jugando",
        createdAt: serverTimestamp(),
      });
      tx.set(queueRef, { waitingCode: null, waitingName: null, waitingSince: null });
      result = { pairId: newPairRef.id };
    } else {
      tx.set(queueRef, { waitingCode: code, waitingName: name, waitingSince: serverTimestamp() });
      result = null;
    }
  });

  return result;
}

/**
 * Listens for a pair to be created, for this round, that includes `code`.
 * Uses a single-field query (round only — no composite index needed) and
 * filters for `code` client-side. Calls onFound(pairId) once.
 */
export function listenForMyPair(fx, { code, round }, onFound) {
  const { collection, query, where, onSnapshot } = fx;
  const pairsCol = collection(fx.db, "pairs");
  const q = query(pairsCol, where("round", "==", round));
  let fired = false;
  const unsub = onSnapshot(q, (snap) => {
    if (fired) return;
    const docs = snap.docs || [];
    const mine = docs.find((d) => {
      const data = d.data();
      return Array.isArray(data.playerCodes) && data.playerCodes.includes(code);
    });
    if (mine) {
      fired = true;
      onFound(mine.id);
    }
  });
  return unsub;
}

export function myRole(pairData, code) {
  if (pairData.player1Code === code) return "player1";
  if (pairData.player2Code === code) return "player2";
  return null;
}

/** Player 1 submits their decision (meaning depends on the round's frame). */
export async function submitDecision(fx, pairId, decision, roundType) {
  const { doc, updateDoc } = fx;
  const patch = { decision };
  patch.status = roundType === "ultimatum" ? "esperando_respuesta" : "completo";
  await updateDoc(doc(fx.db, "pairs", pairId), patch);
}

/** Player 2 accepts or rejects (ultimatum-type rounds only). */
export async function submitAccept(fx, pairId, accepted) {
  const { doc, updateDoc } = fx;
  await updateDoc(doc(fx.db, "pairs", pairId), { accepted, status: "completo" });
}

export function listenToPair(fx, pairId, onChange) {
  const { doc, onSnapshot } = fx;
  return onSnapshot(doc(fx.db, "pairs", pairId), (snap) => {
    if (snap.exists()) onChange({ id: snap.id, ...snap.data() });
  });
}

/**
 * Computes each player's final take for a pair, given that round's config.
 * Returns {p1, p2} in pesos experimentales, or null for a side not yet resolved.
 */
export function computeEarnings(pair, roundCfg) {
  const pot = roundCfg.pot;
  if (roundCfg.frame === "take") {
    const half = pot / 2;
    if (pair.decision === null || pair.decision === undefined) return { p1: null, p2: null };
    const taken = pair.decision;
    return { p1: half + taken, p2: half - taken };
  }
  // give frame
  if (pair.decision === null || pair.decision === undefined) return { p1: null, p2: null };
  const keep = pair.decision;
  if (roundCfg.type === "dictator") {
    return { p1: keep, p2: pot - keep };
  }
  // ultimatum
  if (pair.accepted === true) return { p1: keep, p2: pot - keep };
  if (pair.accepted === false) return { p1: 0, p2: 0 };
  return { p1: null, p2: null };
}
