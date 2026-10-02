import { optimiseAroundGlidePath, mptRationale } from "./mpt.mjs";
export const LIFE_STAGES = [
  ["young", "Young professional — earning, few obligations"],
  ["mid", "Mid-career — family, loans, steady income"],
  ["pre_retirement", "Approaching retirement — protecting what I have"],
  ["retired", "Retired — living off the portfolio"],
];

export const RISK_PROFILES = ["Conservative", "Moderate", "Aggressive"];

/** equity / debt / gold / cash, in percent. Rows sum to 100. */
const BASE = {
  Conservative: {
    young:          { equity: 45, debt: 40, gold: 10, cash: 5 },
    mid:            { equity: 35, debt: 50, gold: 10, cash: 5 },
    pre_retirement: { equity: 20, debt: 65, gold: 10, cash: 5 },
    retired:        { equity: 15, debt: 70, gold: 5,  cash: 10 },
  },
  Moderate: {
    young:          { equity: 70, debt: 20, gold: 5,  cash: 5 },
    mid:            { equity: 60, debt: 30, gold: 5,  cash: 5 },
    pre_retirement: { equity: 40, debt: 50, gold: 5,  cash: 5 },
    retired:        { equity: 25, debt: 60, gold: 5,  cash: 10 },
  },
  Aggressive: {
    young:          { equity: 85, debt: 5,  gold: 5,  cash: 5 },
    mid:            { equity: 75, debt: 15, gold: 5,  cash: 5 },
    pre_retirement: { equity: 55, debt: 35, gold: 5,  cash: 5 },
    retired:        { equity: 35, debt: 50, gold: 5,  cash: 10 },
  },
};

/**
 * Move `points` percent out of equity and into debt (positive) or the other way
 * (negative), keeping the four sleeves at exactly 100.
 *
 * The move is capped by the sleeve it comes OUT of, and applied as one rounded number to
 * both sides. Clamping each side on its own is how an 85/5 aggressive portfolio asked to
 * be bolder becomes 95/0 — a 105% plan.
 */
const shiftEquity = (alloc, points) => {
  const move = Math.round(points >= 0 ? Math.min(points, alloc.equity) : -Math.min(-points, alloc.debt));

  return { ...alloc, equity: alloc.equity - move, debt: alloc.debt + move };
};

/**
 * @param {{risk?: string, lifeStage?: string, horizonYears?: number, tilt?: number}} input
 *   tilt: −1 "make it safer", +1 "make it bolder" — the SRS's advice customisation.
 */
export function allocationFor({ risk = "Moderate", lifeStage = "mid", horizonYears = 10, tilt = 0 } = {}) {
  const profile = RISK_PROFILES.includes(risk) ? risk : "Moderate";
  const stage = BASE[profile][lifeStage] ? lifeStage : "mid";

  let alloc = { ...BASE[profile][stage] };

  // Horizon beats temperament. A three-year goal in an 85% equity portfolio is a
  // questionnaire answer, not a plan.
  if (horizonYears <= 2) alloc = shiftEquity(alloc, alloc.equity - 10);
  else if (horizonYears <= 4) alloc = shiftEquity(alloc, alloc.equity * 0.5);
  else if (horizonYears <= 7) alloc = shiftEquity(alloc, alloc.equity * 0.2);

  if (tilt) alloc = shiftEquity(alloc, -tilt * 10);

  return alloc;
}

/**
 * Which fund categories carry each sleeve, and how much money goes to each.
 * Equity is split rather than dumped into one category — concentration is the failure mode
 * an allocation is supposed to prevent.
 */
export function sleevesFor(alloc, monthlyAmount = 0, risk = "Moderate") {
  const equitySplit =
    risk === "Aggressive"
      ? [["Flexi Cap", 0.4], ["Mid Cap", 0.3], ["Small Cap", 0.3]]
      : risk === "Conservative"
      ? [["Large Cap", 0.7], ["Flexi Cap", 0.3]]
      : [["Large Cap", 0.5], ["Flexi Cap", 0.3], ["Mid Cap", 0.2]];

  const rows = [];

  equitySplit.forEach(([category, share]) => {
    const pct = alloc.equity * share;
    if (pct >= 1) rows.push({ sleeve: "Equity", category, pct: Math.round(pct) });
  });

  if (alloc.debt >= 1) {
    rows.push({ sleeve: "Debt", category: alloc.debt >= 40 ? "Short Duration" : "Corporate Bond", pct: alloc.debt });
  }
  if (alloc.gold >= 1) rows.push({ sleeve: "Gold", category: "Gold", pct: alloc.gold });
  if (alloc.cash >= 1) rows.push({ sleeve: "Cash", category: "Liquid", pct: alloc.cash });

  return rows.map((r) => ({ ...r, amount: Math.round((monthlyAmount * r.pct) / 100) }));
}

/** SRS §8 "Rationale and Insights" — why this, in plain sentences. */
export function rationaleFor({ risk, lifeStage, horizonYears, alloc, goalName }) {
  const stageLabel = (LIFE_STAGES.find(([k]) => k === lifeStage) || ["", "your stage"])[1].split(" — ")[0];
  const lines = [
    `You answered as ${risk.toLowerCase()}, and ${stageLabel.toLowerCase()} portfolios are built around ${
      alloc.equity >= 60 ? "growth" : alloc.equity >= 35 ? "a balance of growth and stability" : "capital protection and income"
    }.`,
    `That is why equity is ${alloc.equity}% and debt ${alloc.debt}%.`,
  ];

  if (horizonYears <= 4) {
    lines.push(
      `Your money is needed in about ${horizonYears} year${horizonYears === 1 ? "" : "s"}, so equity is cut back regardless of risk appetite — a market fall that close to the date cannot be waited out.`
    );
  } else if (horizonYears >= 10) {
    lines.push(`With ${horizonYears}+ years to run, short-term falls have time to recover, which is what makes the equity share affordable.`);
  }

  if (alloc.gold > 0) lines.push(`${alloc.gold}% gold is there as a hedge, not as a return engine.`);
  if (alloc.cash > 0) lines.push(`${alloc.cash}% stays liquid so a bad month never forces you to sell a fund at the wrong time.`);
  if (goalName) lines.push(`This plan is set against your goal "${goalName}".`);

  lines.push("Suggestions are generated from your answers and are not a personal recommendation to buy any specific scheme.");

  return lines;
}

/** Shared by the browser and the scheduled review; one allocation engine. */
export function reviewedPlan(input) {
  const glide = allocationFor(input);
  const optimised = optimiseAroundGlidePath(glide, input.risk);
  const allocation = optimised?.weights || glide;
  return {
    risk: input.risk, life_stage: input.lifeStage, horizon_years: input.horizonYears,
    monthly_amount: input.monthlyAmount,
    allocation, sleeves: sleevesFor(allocation, input.monthlyAmount, input.risk),
    rationale: [...rationaleFor({ ...input, alloc: allocation }), ...mptRationale(optimised, glide)],
  };
}

