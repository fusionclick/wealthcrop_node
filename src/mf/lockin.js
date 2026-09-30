/**
 * QA 3.8, server side — the lock-in the browser already refuses, refused again here.
 *
 * The browser guard (Frontend/src/utils/lockin.js) is the one an investor sees; this is the
 * one a direct API call cannot walk around. Same rules, same fail-open behaviour, so the two
 * can never disagree about whether money is locked. If you change the semantics in one,
 * change them in both — the logic is duplicated deliberately (ESM in the app, CJS here) and
 * `lockin.test.js` pins the cases both must agree on.
 *
 * ── What this refuses to answer ───────────────────────────────────────────────────────────
 * A redemption is an investor's exit and it has to work on the worst day. So this blocks ONLY
 * when it can positively prove the units are still locked, and allows in every other case —
 * BSE performs the authoritative check and rejects a locked redemption itself. Being wrong in
 * the blocking direction traps someone's own money; being wrong in the allowing direction
 * costs a rejected order. Those are not comparable, which is why every unknown allows.
 *
 * `lockIn.period` has NO fixed unit — the unit is the sibling `type`, normalised by
 * scheme.js:lockInOf to "year"/"month"/"day", or left as BSE's raw string when it could not
 * be classified. A period whose unit we cannot read is not a period we can measure.
 */

const UNIT = /^(year|month|day)s?$/i;

const unitOf = (lockIn) => UNIT.exec(String(lockIn?.type || "").trim())?.[1].toLowerCase() || null;

/** A lock-in we can actually measure: a positive period AND a unit we recognise. */
const measurable = (lockIn) => Boolean(unitOf(lockIn)) && Number(lockIn?.period) > 0;

/** The day units bought on `bought` come free — free ON that day, not after it. */
function unlockDate(bought, lockIn) {
  if (!measurable(lockIn) || !(bought instanceof Date) || Number.isNaN(bought.getTime())) return null;

  const period = Number(lockIn.period);
  const d = new Date(bought.getTime());
  // Calendar arithmetic, not period × 30 days: a three-year ELSS comes free on its anniversary.
  if (unitOf(lockIn) === "day") d.setDate(d.getDate() + Math.round(period));
  else d.setMonth(d.getMonth() + Math.round(unitOf(lockIn) === "year" ? period * 12 : period));
  return d;
}

const BUY = /^(p|purchase|sip|new|additional|si)$/i;
// A switch-out and an STP-out both take units off this folio, exactly as a redemption does.
const SELL = /^(r|redeem|redemption|sw|sw[\s_-]*out|switch[\s_-]*out|stp[\s_-]*out|swp)$/i;

/**
 * The still-held purchase lots on one folio, oldest first, from BSE order_list rows.
 *
 * FIFO, because that is the order units actually leave a folio and the only assumption a
 * registrar makes by default. Rows carrying no allotted units yet contribute nothing: an
 * accepted-but-unallotted purchase is not a holding, and counting it would invent a lot with
 * no units in it.
 *
 * @param {Array} rows  order_list rows already narrowed to one scheme + folio
 * @returns {Array<{date: Date, units: number}>}
 */
function openLotsFor(rows = []) {
  const buys = [];
  let sold = 0;

  for (const o of rows) {
    const type = String(o?.trxn_type || o?.order_type || "").trim();
    const units = Math.abs(Number(o?.units) || 0);
    if (!units) continue;

    if (SELL.test(type)) {
      sold += units;
      continue;
    }
    if (!BUY.test(type)) continue;

    const date = new Date(o?.order_date || o?.trxn_date || o?.created_at || NaN);
    if (Number.isNaN(date.getTime())) continue; // an undated lot is a lot we cannot lock
    buys.push({ date, units });
  }

  buys.sort((a, b) => a.date - b.date);

  for (const lot of buys) {
    if (sold <= 0) break;
    const take = Math.min(lot.units, sold);
    lot.units -= take;
    sold -= take;
  }

  return buys.filter((l) => l.units > 1e-9);
}

/**
 * Split lots into what may be redeemed today and what may not. Mirrors the browser's
 * lockinSplit, including its three statuses:
 *   "unknown"   — no measurable lock-in. Never block: a false "your money is locked" on a
 *                 liquid fund is far worse than a missing guard.
 *   "unchecked" — a real lock-in, but no lots to check it against. Allow and say so.
 *   "checked"   — the numbers are real. Only this status may refuse.
 */
function lockinSplit({ lockIn, lots = [], today = new Date() } = {}) {
  const none = { status: "unknown", lockedUnits: 0, freeUnits: 0, nextUnlock: null };
  if (!measurable(lockIn)) return none;

  const usable = lots.filter((l) => Number(l?.units) > 0);
  if (!usable.length) return { ...none, status: "unchecked" };

  let lockedUnits = 0;
  let freeUnits = 0;
  let nextUnlock = null;

  for (const lot of usable) {
    const units = Number(lot.units);
    const unlock = unlockDate(lot.date, lockIn);
    if (!unlock || unlock <= today) {
      freeUnits += units;
      continue;
    }
    lockedUnits += units;
    if (!nextUnlock || unlock < nextUnlock) nextUnlock = unlock;
  }

  return { status: "checked", lockedUnits, freeUnits, nextUnlock };
}

const onDay = (d) =>
  d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "";

/**
 * Should this redemption / switch-out be refused?
 *
 * An order carries an AMOUNT or `all_units`, never a unit count (see mf/order.js), so there
 * are only two cases this can decide without inventing a NAV:
 *
 *   • nothing is free            → refuse whatever was asked for.
 *   • all_units with some locked → refuse, because "all" provably includes locked units.
 *
 * A partial rupee amount against a partly-free folio is left to BSE: converting it to units
 * here needs a NAV we do not have at order time, and a wrong conversion would block a
 * legitimate redemption.
 *
 * @returns {{block: boolean, reason?: string, status: string}}
 */
function redemptionVerdict({ lockIn, rows = [], allUnits = false, today = new Date() } = {}) {
  const lots = openLotsFor(rows);
  const split = lockinSplit({ lockIn, lots, today });

  if (split.status !== "checked") return { block: false, status: split.status };

  const until = onDay(split.nextUnlock);
  const label = lockIn?.label ? ` (${lockIn.label} lock-in)` : "";

  if (split.freeUnits <= 0) {
    return {
      block: true,
      status: split.status,
      reason: `These units are still within their lock-in period${label}. The earliest you can redeem is ${until}.`,
    };
  }

  if (allUnits && split.lockedUnits > 0) {
    return {
      block: true,
      status: split.status,
      reason:
        `${split.lockedUnits.toFixed(3)} of these units are still locked until ${until}${label}. ` +
        `You can redeem up to ${split.freeUnits.toFixed(3)} units now — enter an amount instead of choosing all units.`,
    };
  }

  return { block: false, status: split.status };
}

module.exports = { unlockDate, lockinSplit, openLotsFor, redemptionVerdict };
