// Ticket 16 — CAMS / KFintech Consolidated Account Statement (CAS) import.
//
// An investor's holdings away from this platform already have a home: the External
// Portfolio (Laravel `/portfolio/mf/external`, shown by ExternalMF.jsx and folded into the
// combined view by `combinePortfolio`). So a CAS import is NOT a new portfolio feature —
// it is a way to fill that table without typing thirty rows by hand. Nothing here stores
// anything; it reads the PDF and hands back rows in the shape that table already accepts.
//
// Two jobs, deliberately kept apart so the second is testable without a PDF:
//   pdfLines(buffer, password)  decrypt + extract, the only part that needs pdfjs
//   parseCas(lines)             lines -> folios/schemes/transactions, pure string work
//
// ── What a CAS actually looks like ──────────────────────────────────────────────────────
// Both RTAs emit the same table, one block per scheme inside a folio:
//
//   HDFC Mutual Fund                                      <- AMC, the line above the folio
//   Folio No: 12345678 / 90   PAN: ABCDE1234F   KYC: OK
//   HDFC123-HDFC Liquid Fund - Growth (Advisor: ARN-0) Registrar : CAMS
//   ISIN: INF179K01XQ0
//   Opening Unit Balance: 0.000
//   02-Apr-2024  Purchase        10,000.00    245.678   40.6998   245.678
//   15-Jun-2024  Redemption      (5,000.00)  (120.500)  41.4938   125.178
//   Closing Unit Balance: 125.178  NAV on 31-Mar-2025: INR 44.2100
//   Valuation on 31-Mar-2025: INR 5,533.62
//
// Money out is written in ACCOUNTING PARENTHESES, not with a minus sign — "(5,000.00)" is
// −5000. Miss that and a redemption reads as a second purchase, which is how a cost basis
// silently doubles. KFintech says "Market Value on" where CAMS says "Valuation on", and
// writes the folio without the "/ 90" suffix; everything else matches, so one set of
// patterns covers both rather than two parsers that would drift.

const path = require("path");

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** "1,234.56" -> 1234.56, and CAS's accounting "(1,234.56)" -> -1234.56. */
const num = (raw) => {
  const t = String(raw == null ? "" : raw).replace(/[,\s₹]/g, "");
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const v = Number(t.replace(/[()\-]/g, ""));
  return Number.isFinite(v) ? (negative ? -v : v) : null;
};

/** "02-Apr-2024" -> "2024-04-02". Every date in a CAS is in this one format. */
const isoDate = (raw) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(raw || "").trim());
  const mm = m && MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, "0")}` : null;
};

// A CAS number is always `digits[,digits].decimals`, optionally wrapped in parentheses.
const N = String.raw`\(?-?[\d,]+\.\d+\)?`;

const RE = {
  period: /(\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{2}-[A-Za-z]{3}-\d{4})/i,
  pan: /\bPAN\s*:?\s*([A-Z]{5}\d{4}[A-Z])\b/,
  email: /\bEmail\s*Id\s*:?\s*([^\s]+@[^\s]+)/i,
  folio: /\bFolio\s*No\s*:?\s*([\d][\d\s/]*)/i,
  // "<rta scheme code>-<name> (Advisor: ...) Registrar : CAMS". The advisor block is
  // optional and the name itself is full of hyphens, so the split is on the FIRST one.
  scheme: /^(.+?)\s*Registrar\s*:\s*([A-Za-z]+)/i,
  isin: /\bISIN\s*:?\s*(INF[0-9A-Z]{9})\b/,
  open: new RegExp(String.raw`Opening\s+Unit\s+Balance\s*:?\s*(${N})`, "i"),
  close: new RegExp(String.raw`Closing\s+Unit\s+Balance\s*:?\s*(${N})`, "i"),
  nav: new RegExp(String.raw`NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*INR\s*(${N})`, "i"),
  // CAMS: "Valuation on". KFintech: "Market Value on".
  value: new RegExp(String.raw`(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*INR\s*(${N})`, "i"),
  cost: new RegExp(String.raw`Total\s+Cost\s+Value\s*:?\s*(${N})`, "i"),
  txn: new RegExp(String.raw`^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s+(${N})\s+(${N})\s+(${N})\s+(${N})\s*$`),
};

// Lines that sit directly above a folio but are not the AMC name.
const NOT_AMC = /^(date|transaction|folio|pan|isin|nav|opening|closing|registrar|portfolio|consolidated|email|mobile|market|valuation|total|amount|units|price|nominee)/i;

// pdfjs falls back to the standard 14 fonts for text it cannot map; without this path it
// logs a warning per page. Resolved defensively because the package's export map decides
// whether package.json is reachable, and a missing font dir must not break an import.
let STANDARD_FONTS;
try {
  STANDARD_FONTS = `${path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}${path.sep}`;
} catch {
  STANDARD_FONTS = undefined;
}

/**
 * Decrypt and extract a CAS PDF, one array entry per visual line.
 *
 * pdfjs hands back text fragments with a transform matrix, NOT lines — a table row arrives
 * as six separate items. Grouping by rounded y and sorting by x is what turns them back
 * into the row the investor sees, and every pattern above depends on that row being whole.
 *
 * Throws a tagged Error for the two failures a user can actually fix (`cas_password` /
 * `cas_not_pdf`), so the route can say which one it was instead of "invalid file".
 */
// A since-inception CAS for a busy investor runs to a few dozen pages. The cap is only
// here so an uploaded 5,000-page PDF cannot hold a worker for minutes.
const MAX_PAGES = 300;

async function pdfLines(buffer, password = "") {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      password: String(password || ""),
      // Node has no DOM and no font rendering here — we only ever read text out.
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: STANDARD_FONTS,
    }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") {
      const err = new Error(
        e.code === 2
          ? "That password did not open the statement."
          : "This statement is password protected — enter the password CAMS/KFintech emailed you."
      );
      err.code = "cas_password";
      throw err;
    }
    const err = new Error("That file could not be read as a PDF.");
    err.code = "cas_not_pdf";
    throw err;
  }

  const lines = [];
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= pages; p += 1) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const rows = new Map();
    for (const item of items) {
      const text = String(item.str || "");
      if (!text.trim()) continue;
      // Round y: glyphs on one row differ by a fraction of a point.
      const y = Math.round(item.transform[5]);
      const row = rows.get(y) || [];
      row.push({ x: item.transform[4], text });
      rows.set(y, row);
    }
    // Page coordinates count UP from the bottom, so reading order is descending y.
    [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, row]) => {
        lines.push(
          row
            .sort((a, b) => a.x - b.x)
            .map((i) => i.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        );
      });
    page.cleanup();
  }
  await doc.destroy();
  return lines;
}

/**
 * Average-cost basis for one scheme, walked transaction by transaction.
 *
 * A CAS gives units and a market value but not "what you paid" — buying 100 units twice and
 * selling 40 is not `sum(amounts)`. Every redemption has to remove cost at the average rate
 * it was bought at, which is also how the rest of the industry reports it.
 *
 * Returns null when the statement OPENS with units already held: their cost was paid before
 * the period requested and is genuinely not in this document. Guessing it would put a wrong
 * P&L in the investor's portfolio, so the row is handed over with the cost blank instead.
 */
function costBasis(transactions, openUnits) {
  if (openUnits > 0) return null;
  let cost = 0;
  let units = 0;
  for (const t of transactions) {
    if (!t.units) continue;
    if (t.units > 0) {
      cost += t.amount || 0;
      units += t.units;
    } else {
      const avg = units > 0 ? cost / units : 0;
      cost = Math.max(0, cost - avg * -t.units);
      units = Math.max(0, units + t.units);
    }
  }
  return Number(cost.toFixed(2));
}

/**
 * Lines -> `{ period, pan, email, folios: [{ folio, amc, schemes: [...] }] }`.
 *
 * Pure: give it the array `pdfLines` returns, or a fixture, and it behaves the same.
 */
function parseCas(lines = []) {
  const out = { period: null, pan: null, email: null, folios: [] };
  let folio = null;
  let scheme = null;
  let previous = "";

  const closeScheme = () => {
    if (!scheme) return;
    scheme.transactions.sort((a, b) => a.date.localeCompare(b.date));
    scheme.cost = costBasis(scheme.transactions, scheme.open_units || 0);
    const firstBuy = scheme.transactions.find((t) => t.units > 0);
    scheme.first_buy = firstBuy ? firstBuy.date : null;
    scheme = null;
  };

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;

    if (!out.period) {
      const m = RE.period.exec(line);
      if (m) out.period = { from: isoDate(m[1]), to: isoDate(m[2]) };
    }
    if (!out.email) {
      const m = RE.email.exec(line);
      if (m) out.email = m[1];
    }

    const folioMatch = RE.folio.exec(line);
    if (folioMatch) {
      closeScheme();
      const pan = RE.pan.exec(line)?.[1] || null;
      if (pan && !out.pan) out.pan = pan;
      folio = {
        folio: folioMatch[1].replace(/\s+/g, "").replace(/\/$/, ""),
        amc: NOT_AMC.test(previous) ? null : previous || null,
        pan,
        schemes: [],
      };
      out.folios.push(folio);
      previous = line;
      continue;
    }

    // A standalone "PAN: ..." line (the statement header) before any folio.
    if (!out.pan && !folio) {
      const pan = RE.pan.exec(line)?.[1];
      if (pan) out.pan = pan;
    }

    const schemeMatch = folio && RE.scheme.exec(line);
    if (schemeMatch) {
      closeScheme();
      // "<code>-<name>(Advisor: ...)" — split on the first hyphen, the name owns the rest.
      const head = schemeMatch[1].replace(/\(Advisor\s*:.*?\)/i, "").trim();
      const dash = head.indexOf("-");
      scheme = {
        rta_code: dash > 0 ? head.slice(0, dash).trim() : "",
        scheme_name: (dash > 0 ? head.slice(dash + 1) : head).trim(),
        rta: schemeMatch[2].toUpperCase(),
        isin: RE.isin.exec(line)?.[1] || null,
        open_units: null,
        close_units: null,
        nav: null,
        nav_date: null,
        value: null,
        value_date: null,
        cost: null,
        first_buy: null,
        transactions: [],
      };
      folio.schemes.push(scheme);
      previous = line;
      continue;
    }

    if (scheme) {
      if (!scheme.isin) {
        const isin = RE.isin.exec(line)?.[1];
        if (isin) scheme.isin = isin;
      }
      const open = RE.open.exec(line);
      if (open) scheme.open_units = num(open[1]);
      const close = RE.close.exec(line);
      if (close) scheme.close_units = num(close[1]);
      const nav = RE.nav.exec(line);
      if (nav) {
        scheme.nav_date = isoDate(nav[1]);
        scheme.nav = num(nav[2]);
      }
      const value = RE.value.exec(line);
      if (value) {
        scheme.value_date = isoDate(value[1]);
        scheme.value = num(value[2]);
      }
      const cost = RE.cost.exec(line);
      if (cost) scheme.cost_reported = num(cost[1]);

      const txn = RE.txn.exec(line);
      if (txn) {
        const date = isoDate(txn[1]);
        if (date) {
          scheme.transactions.push({
            date,
            description: txn[2].trim(),
            amount: num(txn[3]),
            units: num(txn[4]),
            nav: num(txn[5]),
            balance: num(txn[6]),
          });
        }
      }
    }

    previous = line;
  }
  closeScheme();

  // The RTA's own cost figure beats ours whenever it printed one — it knows about the
  // period before this statement, and our walk explicitly does not.
  for (const f of out.folios) {
    for (const s of f.schemes) {
      if (s.cost_reported != null) s.cost = s.cost_reported;
    }
  }
  return out;
}

/**
 * Flatten to the rows the External Portfolio table stores — same field names its own
 * "Add Fund" form posts, so importing and typing produce identical records.
 *
 * Only schemes still held are returned: a folio closed two years ago is history, not a
 * holding, and adding it at zero units would just clutter the portfolio.
 */
function casHoldings(parsed) {
  const rows = [];
  for (const folio of parsed.folios || []) {
    for (const s of folio.schemes || []) {
      if (!(s.close_units > 0)) continue;
      rows.push({
        scheme_name: s.scheme_name,
        scheme_isin: s.isin || "",
        folio: folio.folio,
        amc: folio.amc || "",
        rta: s.rta || "",
        units: Number(s.close_units.toFixed(4)),
        nav: s.nav,
        nav_date: s.nav_date,
        statement_value: s.value,
        invested_amount: s.cost,
        purchased_at: s.first_buy,
        source: s.rta ? `CAS (${s.rta})` : "CAS",
        transactions: s.transactions.length,
      });
    }
  }
  return rows;
}

module.exports = { pdfLines, parseCas, casHoldings, costBasis, num, isoDate };
