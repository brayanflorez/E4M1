// chart-data.js: pure functions computing chart-ready data from pair records.
// No DOM, no Firebase. Easy to unit test in isolation before wiring into dashboard.js.

export function bucketDefs(cfg, fmt) {
  const max = cfg.frame === "take" ? cfg.pot / 2 : cfg.pot;
  const step = max / 10;
  return Array.from({ length: 11 }, (_, i) => {
    const v = Math.round(i * step);
    return { value: v, label: fmt(v) };
  });
}

export function computeDecisionFreq(pairs, cfg, fmt) {
  const counts = bucketDefs(cfg, fmt).map((b) => ({ ...b, count: 0 }));
  for (const p of pairs) {
    if (p.decision === null || p.decision === undefined) continue;
    const bucket = counts.find((c) => c.value === p.decision);
    if (bucket) bucket.count++;
  }
  return counts;
}

export function computeWealthDist(pairs, cfg, fmt) {
  const counts = bucketDefs(cfg, fmt).map((b) => ({ ...b, count: 0 }));
  for (const p of pairs) {
    if (p.decision === null || p.decision === undefined) continue;
    let realized;
    if (cfg.type === "ultimatum") {
      if (p.accepted === true) realized = p.decision;
      else if (p.accepted === false) realized = 0;
      else continue;
    } else {
      realized = p.decision;
    }
    const bucket = counts.find((c) => c.value === realized);
    if (bucket) bucket.count++;
  }
  return counts;
}

export function computeAcceptanceByOffer(pairs, cfg, fmt) {
  if (cfg.type !== "ultimatum") return null;
  return bucketDefs(cfg, fmt).map((b) => {
    const withThis = pairs.filter((p) => p.decision === b.value && (p.accepted === true || p.accepted === false));
    const acceptedCount = withThis.filter((p) => p.accepted === true).length;
    return { ...b, n: withThis.length, rate: withThis.length ? acceptedCount / withThis.length : null };
  });
}

/**
 * Splits the total economy of a question ($pot × resolved pairs) into what
 * proposers ended with, what responders ended with, and (ultimatum only)
 * what was destroyed by rejections.
 */
export function computeEconomySplit(pairs, cfg) {
  let proponentes = 0, respondientes = 0, perdido = 0;
  for (const p of pairs) {
    if (p.decision === null || p.decision === undefined) continue;
    if (cfg.type === "ultimatum") {
      if (p.accepted === true) {
        proponentes += p.decision;
        respondientes += cfg.pot - p.decision;
      } else if (p.accepted === false) {
        perdido += cfg.pot;
      } else {
        continue; // not resolved yet, excluded from the split
      }
    } else if (cfg.frame === "take") {
      const half = cfg.pot / 2;
      proponentes += half + p.decision;
      respondientes += half - p.decision;
    } else {
      proponentes += p.decision;
      respondientes += cfg.pot - p.decision;
    }
  }
  return { proponentes, respondientes, perdido, total: proponentes + respondientes + perdido };
}

/** Every individual's realized (post-rejection) earning in a question, for Gini/Lorenz. */
export function individualEarnings(pairs, cfg) {
  const values = [];
  for (const p of pairs) {
    if (p.decision === null || p.decision === undefined) continue;
    let p1, p2;
    if (cfg.type === "ultimatum") {
      if (p.accepted === true) { p1 = p.decision; p2 = cfg.pot - p.decision; }
      else if (p.accepted === false) { p1 = 0; p2 = 0; }
      else continue;
    } else if (cfg.frame === "take") {
      const half = cfg.pot / 2;
      p1 = half + p.decision; p2 = half - p.decision;
    } else {
      p1 = p.decision; p2 = cfg.pot - p.decision;
    }
    values.push(p1, p2);
  }
  return values;
}

/** Gini coefficient (0 = perfectly equal, up to (n-1)/n for total inequality at sample size n). */
export function computeGini(pairs, cfg) {
  const values = individualEarnings(pairs, cfg);
  const n = values.length;
  if (n === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

/** Cumulative [%población, %riqueza] points for a question's Lorenz curve. */
export function computeLorenzPoints(pairs, cfg) {
  const values = individualEarnings(pairs, cfg);
  const n = values.length;
  if (n === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  const points = [[0, 0]];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += sorted[i];
    points.push([(i + 1) / n, total > 0 ? cum / total : (i + 1) / n]);
  }
  return points;
}
