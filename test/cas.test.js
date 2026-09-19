// Ticket 16 — CAS import. The fixture is a real password-protected PDF (rebuild it with
// `python test/fixtures/make-cas.py`), so this covers decryption, the regroup of pdfjs text
// fragments back into table rows, and the parsing — not just the regexes in isolation.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { pdfLines, parseCas, casHoldings, costBasis, num, isoDate } = require("../src/mf/cas");

const FIXTURE = path.join(__dirname, "fixtures", "cas-sample.pdf");
const PASSWORD = "ABCDE1234F";
const pdf = () => fs.readFileSync(FIXTURE);

test("accounting parentheses are money OUT, not a second purchase", () => {
  assert.strictEqual(num("(5,000.00)"), -5000);
  assert.strictEqual(num("10,000.00"), 10000);
  assert.strictEqual(num("-120.500"), -120.5);
  assert.strictEqual(num(""), null);
});

test("CAS dates parse by shape, so 03-04-2026 can never be read as April", () => {
  assert.strictEqual(isoDate("02-Apr-2024"), "2024-04-02");
  assert.strictEqual(isoDate("2024-04-02"), null);
});

test("a redemption removes cost at the average rate, not at its sale price", () => {
  // 100 units for 1000, then 100 more for 3000 = 200 units / 4000. Selling 100 units for
  // 5000 removes 2000 of cost (the average), leaving 2000 — not 4000 - 5000 = -1000.
  const cost = costBasis(
    [
      { date: "2024-01-01", units: 100, amount: 1000 },
      { date: "2024-02-01", units: 100, amount: 3000 },
      { date: "2024-03-01", units: -100, amount: -5000 },
    ],
    0
  );
  assert.strictEqual(cost, 2000);
});

test("units already held when the statement opens means the cost is unknown, not zero", () => {
  assert.strictEqual(costBasis([{ date: "2024-01-01", units: 10, amount: 500 }], 500), null);
});

test("a password-protected statement opens, and says which failure it was", async () => {
  await assert.rejects(() => pdfLines(pdf(), "wrong-one"), (e) => e.code === "cas_password");
  await assert.rejects(() => pdfLines(pdf()), (e) => e.code === "cas_password");
  await assert.rejects(() => pdfLines(Buffer.from("definitely not a pdf")), (e) => e.code === "cas_not_pdf");

  const lines = await pdfLines(pdf(), PASSWORD);
  // The row only exists if the per-cell text fragments were regrouped by their y position.
  assert.ok(lines.includes("02-Apr-2024 Purchase 10,000.00 245.678 40.6998 245.678"));
});

test("the statement parses into folios, schemes and transactions", async () => {
  const cas = parseCas(await pdfLines(pdf(), PASSWORD));

  assert.deepStrictEqual(cas.period, { from: "2024-04-01", to: "2025-03-31" });
  assert.strictEqual(cas.pan, "ABCDE1234F");
  assert.strictEqual(cas.email, "investor@example.com");

  // Two folios at the same AMC stay two folios.
  assert.strictEqual(cas.folios.length, 4);
  assert.deepStrictEqual(
    cas.folios.map((f) => f.folio),
    ["12345678/90", "99887766", "91234567890", "55555555"]
  );
  assert.strictEqual(cas.folios[0].amc, "HDFC Mutual Fund");

  const liquid = cas.folios[0].schemes[0];
  assert.strictEqual(liquid.scheme_name, "HDFC Mid Cap Fund - Growth Option");
  assert.strictEqual(liquid.isin, "INF179K01XQ0");
  assert.strictEqual(liquid.rta, "CAMS");
  assert.strictEqual(liquid.close_units, 125.178);
  assert.strictEqual(liquid.nav, 44.21);
  assert.strictEqual(liquid.value, 5533.62);
  // Purchase and redemption only — the "*** Stamp Duty ***" line carries no units.
  assert.strictEqual(liquid.transactions.length, 2);
  assert.strictEqual(liquid.transactions[1].amount, -5000);
  assert.strictEqual(liquid.transactions[1].units, -120.5);

  // KFintech writes "Market Value on" where CAMS writes "Valuation on".
  const elss = cas.folios[2].schemes[0];
  assert.strictEqual(elss.rta, "KFINTECH");
  assert.strictEqual(elss.value, 77000);
  assert.strictEqual(elss.open_units, 500);
});

test("holdings come back in the shape the external portfolio already stores", async () => {
  const rows = casHoldings(parseCas(await pdfLines(pdf(), PASSWORD)));

  // The fully-redeemed SBI folio is history, not a holding.
  assert.strictEqual(rows.length, 3);
  assert.ok(!rows.some((r) => r.scheme_name.includes("SBI")));

  const sip = rows.find((r) => r.scheme_isin === "INF179K01UT0");
  assert.strictEqual(sip.units, 6.9);
  assert.strictEqual(sip.invested_amount, 10000); // two ₹5,000 SIP installments
  assert.strictEqual(sip.purchased_at, "2024-04-05");
  assert.strictEqual(sip.folio, "99887766");
  assert.strictEqual(sip.source, "CAS (CAMS)");

  // Opening balance carried in from before the period: cost withheld rather than guessed.
  const elss = rows.find((r) => r.scheme_isin === "INF846K01131");
  assert.strictEqual(elss.invested_amount, null);
  assert.strictEqual(elss.units, 700);
});
