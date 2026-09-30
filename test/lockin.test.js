// QA 3.8 — the server-side half of the lock-in guard. The browser already refuses a locked
// redemption; this is the half a direct API call cannot walk around.
//
// Most of these cases pin the ALLOWING direction on purpose. Blocking a redemption traps an
// investor's own money, which is strictly worse than letting an order through for BSE to
// reject, so every uncertainty has to fail open — and that is exactly the property a future
// edit is most likely to break.
const test = require("node:test");
const assert = require("node:assert");

const { unlockDate, lockinSplit, openLotsFor, redemptionVerdict } = require("../src/mf/lockin");

const ELSS = { period: 3, type: "year", label: "3 years" };
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const row = (type, date, units, extra = {}) => ({ trxn_type: type, order_date: date, units, ...extra });

test("unlockDate uses calendar arithmetic, and the anniversary itself is free", () => {
  assert.strictEqual(unlockDate(day("2023-04-10"), ELSS).toISOString().slice(0, 10), "2026-04-10");
  // free ON the anniversary, not after it
  const split = lockinSplit({ lockIn: ELSS, lots: [{ date: day("2023-04-10"), units: 10 }], today: day("2026-04-10") });
  assert.strictEqual(split.freeUnits, 10);
  assert.strictEqual(split.lockedUnits, 0);
});

test("a period with no unit we recognise is not measurable — never blocks", () => {
  for (const lockIn of [null, {}, { period: 3 }, { period: 3, type: "Years???" }, { period: 0, type: "year" }]) {
    const v = redemptionVerdict({ lockIn, rows: [row("P", "2026-09-01", 100)], allUnits: true });
    assert.strictEqual(v.block, false, `must not block on ${JSON.stringify(lockIn)}`);
    assert.strictEqual(v.status, "unknown");
  }
});

test("a real lock-in with no lots to measure is 'unchecked' and still allows", () => {
  const v = redemptionVerdict({ lockIn: ELSS, rows: [], allUnits: true });
  assert.strictEqual(v.block, false);
  assert.strictEqual(v.status, "unchecked");
});

test("an undated purchase row is a lot we cannot lock, so it does not block", () => {
  const v = redemptionVerdict({ lockIn: ELSS, rows: [row("P", "", 100)], allUnits: true });
  assert.strictEqual(v.block, false);
});

test("wholly locked ELSS refuses, and names the unlock date", () => {
  const v = redemptionVerdict({
    lockIn: ELSS,
    rows: [row("P", "2026-09-01", 100)],
    allUnits: false,
    today: day("2026-09-30"),
  });
  assert.strictEqual(v.block, true);
  assert.match(v.reason, /lock-in/i);
  assert.match(v.reason, /2029/); // 2026-09-01 + 3y
});

test("fully matured units redeem freely", () => {
  const v = redemptionVerdict({
    lockIn: ELSS,
    rows: [row("P", "2020-01-01", 100)],
    allUnits: true,
    today: day("2026-09-30"),
  });
  assert.strictEqual(v.block, false);
  assert.strictEqual(v.status, "checked");
});

test("part-locked: 'all units' is refused but a partial amount is left to BSE", () => {
  const rows = [row("P", "2020-01-01", 60), row("P", "2026-09-01", 40)];
  const today = day("2026-09-30");

  const all = redemptionVerdict({ lockIn: ELSS, rows, allUnits: true, today });
  assert.strictEqual(all.block, true);
  assert.match(all.reason, /40\.000 of these units are still locked/);
  assert.match(all.reason, /redeem up to 60\.000/);

  // A rupee amount cannot be converted to units without a NAV, so it is not ours to refuse.
  const partial = redemptionVerdict({ lockIn: ELSS, rows, allUnits: false, today });
  assert.strictEqual(partial.block, false);
});

test("earlier redemptions consume the oldest lots first, so FIFO leaves the NEW ones locked", () => {
  // 60 old units bought 2020, 40 new in 2026; 60 already redeemed => only locked units remain.
  const rows = [row("P", "2020-01-01", 60), row("P", "2026-09-01", 40), row("R", "2026-09-15", 60)];
  const lots = openLotsFor(rows);
  assert.deepStrictEqual(
    lots.map((l) => [l.date.toISOString().slice(0, 10), l.units]),
    [["2026-09-01", 40]]
  );

  const v = redemptionVerdict({ lockIn: ELSS, rows, allUnits: false, today: day("2026-09-30") });
  assert.strictEqual(v.block, true, "nothing is free once the matured lot has been sold");
});

test("a switch-out is a sale: it takes units off the folio like a redemption", () => {
  for (const sell of ["SW", "switch_out", "STP_OUT", "SWP", "R"]) {
    const lots = openLotsFor([row("P", "2020-01-01", 50), row(sell, "2026-01-01", 50)]);
    assert.strictEqual(lots.length, 0, `${sell} must reduce the folio`);
  }
});

test("accepted-but-unallotted purchases carry no units and invent no lots", () => {
  assert.deepStrictEqual(openLotsFor([row("P", "2026-09-01", 0, { status: "ACCEPTED" })]), []);
});
