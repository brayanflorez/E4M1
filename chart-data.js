// chart-data.js — pure functions computing chart-ready data from pair records.
// No DOM, no Firebase — easy to unit test in isolation before wiring into dashboard.js.

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
