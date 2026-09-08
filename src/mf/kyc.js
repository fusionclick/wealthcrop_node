// ponytail: KYC ka faisla BSE ka hai, hamara nahi — get_ucc ke `ucc_status` se kyc_status
// nikalta hai, aur kisi cheez se nahi. `transaction_ready[].verified_status` par gate mat
// lagana: wo har accepted order par FALSE tha (memory: bse-ucc-lifecycle).
const UCC_TO_KYC = {
  APPROVED: "verified",
  PENDING_VERIFICATION: "pending",
  PENDING: "pending",
  REJECTED: "rejected",
  DEACTIVATED: "rejected",
  INACTIVE: "rejected",
};

/**
 * get_ucc `data` → { ucc, ucc_status, kyc_status, reasons, transaction_ready, checked_at }.
 * Record na ho (BSE par nahi mila / pahunch nahi paye) to kyc_status "unknown" —
 * Laravel usay kabhi store nahi karta, stored value jaisi thi waisi rehti hai.
 */
function kycFromUcc(record, ucc) {
  const uccStatus = record?.ucc_status ? String(record.ucc_status).trim().toUpperCase() : null;
  const ready = Array.isArray(record?.transaction_ready) ? record.transaction_ready : [];
  const reasons = [...new Set(ready.map((t) => String(t?.verification_failed_reason || "").trim()).filter(Boolean))];
  return {
    ucc: String(ucc || record?.investor?.client_code || record?.client_code || ""),
    ucc_status: uccStatus,
    kyc_status: UCC_TO_KYC[uccStatus] || "unknown",
    reasons,
    transaction_ready: ready,
    checked_at: new Date().toISOString(),
  };
}

// ponytail: UCC ka maalik kaun hai — BSE ke get_ucc record se PAN nikalta hai. Shape
// ek hi probe se maloom hai, is liye kuch candidate paths; PAN na mile to null.
// Caller null ko "pata nahi" samajhta hai (block nahi karta) par log karta hai —
// warna ek field rename har investor ko 403 de deta.
function uccPan(record) {
  const holders = [record?.holder, record?.holders, record?.investor?.holder]
    .filter(Array.isArray)
    .flat();
  const ids = [
    ...holders.flatMap((h) => (Array.isArray(h?.identifier) ? h.identifier : [])),
    ...holders.flatMap((h) => (Array.isArray(h?.identifiers) ? h.identifiers : [])),
    ...(Array.isArray(record?.identifier) ? record.identifier : []),
  ];
  const fromIds = ids.find((i) => String(i?.identifier_type || "").toLowerCase() === "pan");
  const raw =
    fromIds?.identifier_number ||
    holders.find((h) => h?.pan)?.pan ||
    record?.pan ||
    record?.pan_number ||
    "";
  const pan = String(raw).trim().toUpperCase();
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? pan : null;
}

// The investor's own PAN, as Laravel's investor-data reports it.
function investorPan(investor) {
  const pan = String(investor?.profile?.pan_number || investor?.pan || "").trim().toUpperCase();
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? pan : null;
}

module.exports = { UCC_TO_KYC, kycFromUcc, uccPan, investorPan };
