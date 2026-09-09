// Turn BSE's add_ucc rejections into something an investor can act on.
//
// The old inline map was keyed by msgid and covered 526 and 560. Everything else fell to
// `{ field: msg.field, message: msg.errcode }`, so the KYC screen printed the raw code —
// "alpha_special" over "Check the field and try again", with no hint that the problem was
// a digit in the holder's name.
//
// Two things that map missed:
//   msgid is not a reliable key. The alpha_special rejection arrives as msgid 0, so no
//   msgid-keyed entry can ever match it. Key by errcode as well.
//   BSE usually explains itself in vals[0] — for alpha_special that is "Holder name should
//   only contain lettersandspaces and special characters( "." , "'" )", and vals[1] is the
//   offending value. Throwing that away and printing the code instead was the whole
//   problem; prefer BSE's own words, tidied.

const BY_MSGID = {
  526: {
    field: "address.line1",
    message: "Address line 1 is too short — minimum 8 characters required",
    fix: 'Enter a more detailed address (e.g. "Flat 12, Green Park Society")',
  },
  560: {
    field: "address.pincode",
    message: "Invalid pincode — this postal code does not exist in India",
    fix: "Use a valid 6-digit India pincode (e.g. 700091)",
  },
};

const BY_ERRCODE = {
  alpha_special: {
    message: "Name may contain only letters, spaces, '.' and \"'\"",
    fix: "Remove digits and other symbols — it must match your PAN card",
  },
};

// BSE runs words together in its own text ("lettersandspaces") and uses curly quotes.
const tidy = (s) =>
  String(s || "")
    .replace(/[‘’“”]/g, '"')
    .replace(/lettersandspaces/gi, "letters and spaces")
    .replace(/\s+/g, " ")
    .trim();

/** A BSE message -> {field, message, fix}. Never throws, always returns something usable. */
function mapBseError(msg = {}) {
  const known = BY_MSGID[msg.msgid] || BY_ERRCODE[msg.errcode] || null;
  const explanation = tidy(Array.isArray(msg.vals) ? msg.vals[0] : "");
  const offending = Array.isArray(msg.vals) && msg.vals.length > 1 ? tidy(msg.vals[1]) : "";

  // BSE's own sentence beats a code; our copy beats a blank.
  const message =
    known?.message || explanation || `${msg.field || "A field"} was rejected by BSE`;

  const fix =
    known?.fix ||
    (offending ? `Rejected value: "${offending}"` : "Check the field and try again");

  return { field: known?.field || msg.field || null, message, fix };
}

const mapBseErrors = (messages = []) => messages.map(mapBseError);

module.exports = { mapBseError, mapBseErrors, BY_MSGID, BY_ERRCODE };
