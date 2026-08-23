const NO = new Set(["n", "no", "false", "0", "inactive", "closed", "disabled", "not allowed"]);
const YES = new Set(["y", "yes", "true", "1", "allowed", "active", "open"]);

function flag(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (NO.has(s)) return false;
  if (YES.has(s)) return true;
  return null;
}

function isTransactable(scheme = {}) {
  if (flag(scheme.scheme_status || scheme.status) === false) return false;
  if (flag(scheme.purchase_allowed ?? scheme.purchase_allow ?? scheme.txn_allowed ?? scheme.transaction_allowed) === false) {
    return false;
  }
  return true;
}

function mapScheme(scheme = {}, index = 0) {
  const name = scheme.name || scheme.scheme_name || "";
  const isin = scheme.scheme_isin || scheme.isin || "";
  const bseCode = scheme.scheme_bse_code || scheme.bse_scheme_code || "";
  const category = scheme.scheme_category || "";
  const sub = scheme.scheme_sub_category || "";
  const minLumpsum = scheme.min_lumpsum_amount ?? scheme.min_amt ?? scheme.minLumpsum;
  const minSip = scheme.sip_min_amount ?? scheme.minSip;
  const minRedeem = scheme.min_redemption_amount ?? scheme.min_redeem_amt;
  const nav = scheme.nav ?? scheme.nav_value;
  return {
    id: index + 1,
    name,
    category: category || "Mutual Fund",
    subType: [category, sub].filter(Boolean).join(" • ") || "Mutual Fund",
    scheme_isin: isin,
    scheme_isin: isin,
    scheme_bse_code: bseCode,
    scheme_bse_code: bseCode,
    nav: nav != null && nav !== "" ? Number(nav) : null,
    minSip: minSip != null && minSip !== "" ? Number(minSip) : null,
    minLumpsum: minLumpsum != null && minLumpsum !== "" ? Number(minLumpsum) : null,
    minLumpsum: minLumpsum != null && minLumpsum !== "" ? Number(minLumpsum) : null,
    minRedeem: minRedeem != null && minRedeem !== "" ? Number(minRedeem) : null,
    purchase_allowed: scheme.purchase_allowed ?? scheme.purchase_allow ?? null,
    sip_allowed: scheme.sip_allowed ?? scheme.sip_flag ?? null,
    scheme_status: scheme.scheme_status || scheme.status || null,
    scheme_plan: scheme.scheme_plan || null,
    scheme_option: scheme.scheme_option || null,
    scheme_amc_name: scheme.scheme_amc_name || scheme.amc_name || null,
    logoText: name ? name.charAt(0).toUpperCase() : "F",
    returns: { "1Y": null, "3Y": null, "5Y": null },
    returns: { "1Y": null, "3Y": null, "5Y": null },
  };
}

function parseListQuery(body = {}) {
  const src = body.data && typeof body.data === "object" ? body.data : body;
  const start = Math.max(0, Number(src.start ?? 0) || 0);
  const length = Math.min(100, Math.max(1, Number(src.length ?? 20) || 20));
  const searchRaw = src.search && typeof src.search === "object" ? src.search.value : src.search;
  const search = String(searchRaw || body.search || "").trim();
  const category = String(body.category || src.category || src.filter_param?.scheme_category || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const isin = String(body.isin || body.scheme_isin || src.scheme_isin || "").trim();
  const scheme_code = String(body.scheme_code || body.scheme_bse_code || src.scheme_code || "").trim();
  return { start, length, search, category, isin, scheme_code };
}

function categorySearch(category) {
  return (
    {
      gold_funds: "GOLD",
      large_cap: "LARGE CAP",
      mid_cap: "MID CAP",
      small_cap: "SMALL CAP",
      high_return: "FLEXI CAP",
      "5_star_funds": "BLUECHIP",
    }[category] || ""
  );
}

function matchesCategory(item, category) {
  if (!category) return true;
  const hay = `${item.subType || ""} ${item.name || ""} ${item.category || ""}`.toLowerCase();
  if (category === "large_cap") return hay.includes("large cap") || hay.includes("large & mid");
  if (category === "mid_cap") return /\bmid cap\b/.test(hay) || hay.includes("large & mid");
  if (category === "small_cap") return hay.includes("small cap");
  if (category === "gold_funds") {
    return /\bgold\b/.test(hay) || /\bsilver\b/.test(hay) || hay.includes("precious metal");
  }
  return true;
}

function paginate(list, start, length) {
  return list.slice(start, start + length);
}

module.exports = {
  flag,
  isTransactable,
  isTransactable: isTransactable,
  mapScheme,
  mapScheme: mapScheme,
  parseListQuery,
  parseListQuery: parseListQuery,
  matchesCategory,
  categorySearch,
  paginate,
  paginate: paginate,
};
