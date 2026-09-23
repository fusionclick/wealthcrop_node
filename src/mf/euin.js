/**
 * EUIN and the distributor block that rides on every BSE StarMF payload.
 *
 * AMFI's rule, and the one the compliance spec calls out in bold: **never send EUINDecl "Y"
 * together with a non-empty EUIN**. The two say opposite things. EUINDecl "Y" is the
 * investor declaring the trade was execution-only — placed without any interaction or advice
 * from an employee — and an EUIN is the identity of the employee who advised it. A payload
 * carrying both is a contradiction the exchange cannot resolve, and it is the single thing
 * that puts trail commission eligibility at risk on an audit.
 *
 * Before this file there was no `mem_details` on a purchase at all. That is NOT the same as
 * declaring execution-only: BSE reads a missing declaration as "not declared", so every
 * order this platform has placed was unattributed rather than execution-only. The other two
 * sites were worse — `KYC.jsx` registered every investor against a hardcoded **EUIN
 * E234123** and **ARN-873456**, and the SIP fixture carried **E000001**. None of those
 * numbers belong to this distributor.
 *
 * This platform has no relationship-manager concept: nothing in any of the three repos
 * assigns an employee to an investor, and no screen offers "placed with assistance". So
 * every trade here IS execution-only, and that is what goes out — but the shape is written
 * to take an EUIN the day an RM module exists, and `memDetails` refuses the illegal pair
 * rather than trusting the caller to remember.
 */

// The distributor's own ARN. Never a literal in a payload builder — a wrong ARN in a live
// order is a misattributed commission, and the one that used to be hardcoded was not ours.
//
// Read from the admin panel via the cached distributor settings, with env as the seed, so
// the ARN printed on the footer and the ARN sent to BSE are the same value by construction
// rather than by two people remembering to change two places.
const { cachedDistributor } = require("./distributor");

const ARN = () => cachedDistributor().arn || "";
const SUB_BROKER_CODE = () => cachedDistributor().sub_br_code || "";

// BSE spells the declaration `euin_flag` on this API; the spec calls it EUINDecl. Same field.
const EXECUTION_ONLY = { euin: "", euin_flag: true };

/**
 * @param {object} opts
 * @param {string} [opts.euin]        The advising employee's EUIN, when one genuinely advised.
 * @param {boolean} [opts.omitEmpty]  Drop keys with no value (see below). Default true.
 *
 * Passing an EUIN switches the declaration off, because the trade was then not
 * execution-only. Passing nothing declares execution-only. There is no way to ask for both.
 *
 * ── Why empty keys are dropped by default ────────────────────────────────────────────────
 * `/sxp_register` rejects an empty string ANYWHERE in the payload — one of them poisons the
 * whole request, which is why the builder above goes out of its way never to emit one. A
 * blanket `{euin: "", sub_br_code: "", sub_br_arn: "", partner_id: ""}` would therefore have
 * broken every SIP registration on the platform.
 *
 * Omitting `euin` is not a weaker declaration than sending it empty: the statement is carried
 * by `euin_flag`, and an absent EUIN alongside it says exactly what an empty one says — no
 * employee advised this. What matters, and what is preserved either way, is that the
 * declaration is never sent next to a NAMED employee.
 */
function memDetails({ euin = "", omitEmpty = true } = {}) {
  const advised = String(euin || "").trim().toUpperCase();
  const block = {
    // Exactly one of these two shapes is ever produced, by construction rather than by
    // discipline: there is no code path that sets both.
    ...(advised ? { euin: advised, euin_flag: false } : EXECUTION_ONLY),
    sub_br_code: SUB_BROKER_CODE(),
    sub_br_arn: ARN(),
    partner_id: "",
  };
  if (!omitEmpty) return block;
  return Object.fromEntries(Object.entries(block).filter(([, v]) => v !== "" && v != null));
}

/**
 * Last line of defence, run on the fully-built payload just before it leaves for BSE.
 *
 * memDetails() cannot produce the illegal pair, but a caller can still spread a `mem_details`
 * of its own over the top — which is exactly how the fabricated EUIN reached the exchange in
 * the first place. So the outgoing object is checked, not the intent.
 *
 * @throws {Error} when a payload declares execution-only and names an employee at once.
 */
function assertEuinSane(memDetailsObj = {}) {
  const euin = String(memDetailsObj.euin || "").trim();
  const declared = memDetailsObj.euin_flag === true || memDetailsObj.euin_flag === "Y";
  if (declared && euin) {
    throw new Error(
      `EUIN declaration conflict: euin_flag is set while euin is "${euin}". ` +
        "An execution-only declaration and a named employee cannot both be true.",
    );
  }
  return memDetailsObj;
}

/** Attach the block to a BSE payload's `data`, verified. Callers never build it by hand. */
function withMemDetails(data = {}, opts = {}) {
  return { ...data, mem_details: assertEuinSane(memDetails(opts)) };
}

module.exports = { memDetails, assertEuinSane, withMemDetails, ARN, EXECUTION_ONLY };
