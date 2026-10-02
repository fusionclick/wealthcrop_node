/**
 * SRS §8 — "Investment Models: the system uses sophisticated investment models and
 * strategies. The document explicitly mentions Modern Portfolio Theory (MPT) for
 * portfolio optimization."
 *
 * This is the optimiser. `advisor.js` holds the glide path — what an investor at this
 * stage and risk tolerance is ALLOWED to hold — and this file decides where inside those
 * bounds the money should actually sit, by maximising
 *
 *     U(w) = wᵀμ − (λ/2) · wᵀΣw
 *
 * subject to Σw = 1 and L ≤ w ≤ U. That is textbook constrained mean-variance: μ is the
 * expected-return vector, Σ the covariance matrix, λ the investor's risk aversion.
 *
 * ── Why the two are combined rather than one replacing the other ─────────────────────────
 * An unconstrained optimiser run on any plausible set of assumptions puts a retiree in
 * 80% equity about as often as not — mean-variance is famously sensitive to its inputs
 * and has no concept of "this person needs the money in three years". The glide path is
 * the suitability rule; MPT allocates inside it. Neither alone is defensible.
 *
 * ── Why projected gradient and not a closed form ─────────────────────────────────────────
 * The closed form (w ∝ Σ⁻¹μ) is only valid when weights may go negative. Short-selling a
 * mutual-fund sleeve is not a thing an investor can do, so the long-only bounds are the
 * whole problem, and a solution that ignores them is worse than no optimiser. Projected
 * gradient ascent honours them exactly, needs no matrix inversion, and is deterministic —
 * the same inputs give the same answer, which matters when it has to be explained.
 */

/**
 * Capital market assumptions — expected annual return and volatility per sleeve, and the
 * correlations between them.
 *
 * These are ASSUMPTIONS, not measurements, and the optimiser is only as good as they are.
 * They are kept here, named, and overridable so they can be reviewed and changed by
 * whoever owns them, rather than being scattered through the maths as magic numbers.
 *
 * Broadly consistent with long-run Indian market history: equity ~12% at ~18% vol, debt
 * ~7% at ~4%, gold ~8% at ~14%, cash ~6% at ~1%. Gold's low correlation to equity is the
 * reason it earns a place at all despite a lower return.
 */
export const DEFAULT_ASSUMPTIONS = {
  keys: ["equity", "debt", "gold", "cash"],
  mu: { equity: 0.12, debt: 0.07, gold: 0.08, cash: 0.06 },
  sigma: { equity: 0.18, debt: 0.04, gold: 0.14, cash: 0.01 },
  // Symmetric; only the pairs that matter are listed, the rest default to 0.
  correlation: {
    "equity:debt": 0.15,
    "equity:gold": -0.1,
    "equity:cash": 0.0,
    "debt:gold": 0.05,
    "debt:cash": 0.3,
    "gold:cash": 0.0,
  },
};

const corrOf = (assumptions, a, b) => {
  if (a === b) return 1;
  const c = assumptions.correlation;
  return c[`${a}:${b}`] ?? c[`${b}:${a}`] ?? 0;
};

/** Σ, as a dense matrix in the order of `keys`. σᵢσⱼρᵢⱼ. */
export function covarianceMatrix(assumptions = DEFAULT_ASSUMPTIONS) {
  const { keys, sigma } = assumptions;
  return keys.map((a) => keys.map((b) => sigma[a] * sigma[b] * corrOf(assumptions, a, b)));
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const matVec = (m, v) => m.map((row) => dot(row, v));

/** wᵀΣw — portfolio variance. */
export function portfolioVariance(weights, cov) {
  return dot(weights, matVec(cov, weights));
}

export function portfolioReturn(weights, keys, mu) {
  return keys.reduce((s, k, i) => s + weights[i] * mu[k], 0);
}

/**
 * Project a weight vector onto { Σw = 1, lo ≤ w ≤ hi }.
 *
 * Clamping and then re-normalising is the obvious approach and it is wrong: dividing by
 * the sum pushes weights back outside their bounds. The correct projection subtracts one
 * shared scalar θ from every weight before clamping, chosen so the clamped total is
 * exactly 1. θ is found by bisection — Σᵢ clamp(wᵢ − θ) is monotone decreasing in θ, so
 * it cannot get stuck.
 */
export function projectToSimplex(w, lo, hi) {
  const clampAll = (theta) => w.map((wi, i) => Math.min(hi[i], Math.max(lo[i], wi - theta)));
  const total = (theta) => clampAll(theta).reduce((a, b) => a + b, 0);

  // The bounds themselves may make Σw = 1 impossible; say so rather than returning a
  // plausible-looking vector that does not add up.
  const loSum = lo.reduce((a, b) => a + b, 0);
  const hiSum = hi.reduce((a, b) => a + b, 0);
  if (loSum > 1 + 1e-9 || hiSum < 1 - 1e-9) return null;

  let left = Math.min(...w) - 1;
  let right = Math.max(...w) + 1;

  for (let i = 0; i < 100; i += 1) {
    const mid = (left + right) / 2;
    if (total(mid) > 1) left = mid;
    else right = mid;
  }

  return clampAll((left + right) / 2);
}

/**
 * Maximise wᵀμ − (λ/2)wᵀΣw subject to Σw = 1 and the box bounds.
 *
 * @param {number} lambda      risk aversion. 0 chases return alone; large values converge
 *                             on the minimum-variance portfolio.
 * @param {object} bounds      { equity: [lo, hi], ... } as fractions. Absent keys are [0,1].
 * @returns {{weights: object, ret: number, vol: number, utility: number} | null}
 */
export function optimise({ lambda = 3, bounds = {}, assumptions = DEFAULT_ASSUMPTIONS } = {}) {
  const { keys, mu } = assumptions;
  const cov = covarianceMatrix(assumptions);
  const n = keys.length;

  const lo = keys.map((k) => bounds[k]?.[0] ?? 0);
  const hi = keys.map((k) => bounds[k]?.[1] ?? 1);

  let w = projectToSimplex(Array.from({ length: n }, () => 1 / n), lo, hi);
  if (!w) return null;

  const muVec = keys.map((k) => mu[k]);
  // 1/L for a Lipschitz-ish step: the gradient's curvature is λΣ, so scaling the step by
  // its largest diagonal keeps the ascent from oscillating on the volatile sleeve.
  const scale = Math.max(...cov.map((row, i) => row[i])) * Math.max(lambda, 1e-6);
  const step = 1 / (scale + 1);

  for (let iter = 0; iter < 4000; iter += 1) {
    const grad = muVec.map((m, i) => m - lambda * dot(cov[i], w));
    const next = projectToSimplex(
      w.map((wi, i) => wi + step * grad[i]),
      lo,
      hi
    );
    if (!next) break;

    const moved = next.reduce((s, v, i) => s + Math.abs(v - w[i]), 0);
    w = next;
    if (moved < 1e-10) break;
  }

  const ret = portfolioReturn(w, keys, mu);
  const variance = portfolioVariance(w, cov);

  return {
    weights: Object.fromEntries(keys.map((k, i) => [k, w[i]])),
    ret,
    vol: Math.sqrt(Math.max(variance, 0)),
    utility: ret - (lambda / 2) * variance,
  };
}

/**
 * The efficient frontier: the optimum at a range of risk aversions, lowest risk first.
 *
 * Used for the chart on the advice screen and, more usefully, as the thing that makes the
 * single recommended point explicable — "here is the whole menu, here is where you are".
 */
export function efficientFrontier({ bounds = {}, assumptions = DEFAULT_ASSUMPTIONS, points = 12 } = {}) {
  // Geometric spacing: the interesting part of the curve is at low λ, and a linear sweep
  // spends most of its samples on a flat tail.
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const lambda = 0.5 * Math.pow(60, i / Math.max(points - 1, 1));
    const p = optimise({ lambda, bounds, assumptions });
    if (p) out.push({ lambda, ...p });
  }
  return out.sort((a, b) => a.vol - b.vol);
}

/**
 * Risk aversion for a profile. Higher λ = more weight on variance in the utility.
 *
 * Three numbers rather than a formula because there are exactly three profiles and a
 * curve fitted through three points is pure decoration.
 */
export const LAMBDA = { Conservative: 12, Moderate: 5, Aggressive: 1.8 };

/**
 * The bridge between the glide path and the optimiser.
 *
 * The glide-path allocation becomes a BAND rather than a fixed answer: each sleeve may
 * move `slack` percentage points either side of it, and mean-variance picks the point
 * inside that box with the best risk-adjusted return. So suitability still decides the
 * shape of the portfolio and MPT decides the detail — which is the only division of
 * labour that survives both a regulator and a bad decade.
 *
 * @param {object} glideAlloc  { equity, debt, gold, cash } in PERCENT, summing to 100
 * @param {string} risk        Conservative | Moderate | Aggressive
 * @param {number} slack       band half-width in percentage points
 * @returns {{weights: object, ret: number, vol: number, sharpe: number, shifts: object}}
 */
export function optimiseAroundGlidePath(glideAlloc, risk = "Moderate", { slack = 10, assumptions = DEFAULT_ASSUMPTIONS } = {}) {
  const keys = assumptions.keys;
  const band = glideBounds(glideAlloc, slack, keys);
  const bounds = Object.fromEntries(keys.map((k) => [k, [band[k][0] / 100, band[k][1] / 100]]));

  const solved = optimise({ lambda: LAMBDA[risk] ?? LAMBDA.Moderate, bounds, assumptions });
  if (!solved) return null;

  // Whole percentages, still summing to 100 — largest remainder, same as everywhere else
  // in this app that has to divide something indivisible.
  const pct = roundToHundred(keys.map((k) => solved.weights[k] * 100));

  const weights = Object.fromEntries(keys.map((k, i) => [k, pct[i]]));
  const shifts = Object.fromEntries(keys.map((k) => [k, weights[k] - (Number(glideAlloc?.[k]) || 0)]));

  return {
    weights,
    ret: solved.ret,
    vol: solved.vol,
    // Excess return per unit of risk, over the cash sleeve as the risk-free proxy.
    sharpe: solved.vol > 0 ? (solved.ret - assumptions.mu.cash) / solved.vol : 0,
    shifts,
  };
}

/**
 * The suitability band: each sleeve may sit `slack` points either side of the glide path,
 * clamped to 0–100, in PERCENT. The optimiser searches inside it, and Audit #58's hand-made
 * split is held to the very same box — one definition, so "customise" can never reach a
 * portfolio the optimiser would have been forbidden to suggest.
 */
export function glideBounds(glideAlloc, slack = 10, keys = DEFAULT_ASSUMPTIONS.keys) {
  return Object.fromEntries(
    keys.map((k) => {
      const centre = Number(glideAlloc?.[k]) || 0;
      return [k, [Math.max(0, centre - slack), Math.min(100, centre + slack)]];
    })
  );
}

/**
 * Audit #58 — a split the investor typed: whole percentages, adding to exactly 100, each
 * inside its band. Returns the reasons it is not acceptable (empty when it is).
 */
export function manualSplitErrors(split, band) {
  const errors = [];
  const keys = Object.keys(band);
  const values = keys.map((k) => Number(split?.[k]));

  if (values.some((v) => !Number.isInteger(v))) errors.push("Use whole percentages.");
  const total = values.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  if (total !== 100) errors.push(`The sleeves add up to ${total}%, not 100%.`);

  keys.forEach((k, i) => {
    const [lo, hi] = band[k];
    if (Number.isFinite(values[i]) && (values[i] < lo || values[i] > hi)) {
      errors.push(`${k[0].toUpperCase()}${k.slice(1)} must stay between ${lo}% and ${hi}% for your profile.`);
    }
  });

  return errors;
}

/** Expected return, volatility and Sharpe of any split (in percent), on the same assumptions. */
export function statsFor(weightsPct, assumptions = DEFAULT_ASSUMPTIONS) {
  const w = assumptions.keys.map((k) => (Number(weightsPct?.[k]) || 0) / 100);
  const ret = portfolioReturn(w, assumptions.keys, assumptions.mu);
  const vol = Math.sqrt(Math.max(portfolioVariance(w, covarianceMatrix(assumptions)), 0));
  return { ret, vol, sharpe: vol > 0 ? (ret - assumptions.mu.cash) / vol : 0 };
}

/** Round a set of percentages to integers that still total 100. */
export function roundToHundred(values) {
  const floored = values.map(Math.floor);
  let left = 100 - floored.reduce((a, b) => a + b, 0);

  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) floored[order[k].i] += 1;

  return floored;
}

/** SRS §8 "Rationale and Insights" — what the optimiser changed, and why. */
export function mptRationale(result, glideAlloc) {
  if (!result) return [];

  const LABEL = { equity: "equity", debt: "debt", gold: "gold", cash: "cash" };
  const moved = Object.entries(result.shifts)
    .filter(([, d]) => Math.abs(d) >= 1)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const lines = [
    `Expected return ${(result.ret * 100).toFixed(1)}% a year with about ${(result.vol * 100).toFixed(1)}% volatility — a risk-adjusted return (Sharpe) of ${result.sharpe.toFixed(2)}.`,
  ];

  if (!moved.length) {
    lines.push(
      "Mean-variance optimisation left your suitable allocation unchanged: it was already the best risk-adjusted mix available within your limits."
    );
    return lines;
  }

  lines.push(
    "Within the limits your profile allows, optimising for risk-adjusted return moved " +
      moved
        .map(([k, d]) => `${LABEL[k]} ${d > 0 ? "up" : "down"} ${Math.abs(d)} point${Math.abs(d) === 1 ? "" : "s"}`)
        .join(", ") +
      "."
  );

  if (result.shifts.gold > 0) {
    lines.push(
      "Gold went up because it has historically moved against equity, so a slice of it lowers the whole portfolio's swing by more than it costs in return."
    );
  }

  lines.push(
    `Return and volatility come from stated long-run assumptions (equity ${(DEFAULT_ASSUMPTIONS.mu.equity * 100).toFixed(0)}% at ${(
      DEFAULT_ASSUMPTIONS.sigma.equity * 100
    ).toFixed(0)}% volatility, debt ${(DEFAULT_ASSUMPTIONS.mu.debt * 100).toFixed(0)}% at ${(DEFAULT_ASSUMPTIONS.sigma.debt * 100).toFixed(
      0
    )}%), not from a forecast. Actual results will differ.`
  );

  return lines;
}
