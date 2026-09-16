// Canonical names for utility companies.
//
// 29 distinct spellings existed across 121 utility rows: "Washington GAS"
// and "Washington Gas" and "Wash Gas"; "BGE" and "bge"; "pepco" and
// "Pepco"; "wssC" and "wssc" and "WSSC". They came from three places that
// never agreed -- the QuickBooks import, the property import, and whoever
// typed a row by hand -- and the result is that a per-provider total splits
// across spellings and a lookup by name misses rows that are plainly there.
//
// WHAT THIS DELIBERATELY DOES NOT DO: collapse an entity suffix. "BGE
// Sigma", "BGE Utopia", "BGE Bluestar" and "BGE Sycamore" are four separate
// logins for four separate LLCs, not four spellings of "BGE". Flattening
// them would merge credentials between companies, which is the one mistake
// here with a real blast radius. The base name is canonicalised and the
// suffix preserved.

// base spelling -> canonical. Matched on a lowercased, punctuation-stripped
// form so "Wash. Gas", "WASH GAS" and "washgas" all land together.
const CANON = [
  [/^(washingtongas|washgas|wgl|wglgas|washingtongaslight)$/, "Washington Gas"],
  [/^(pepco|potomacelectric|potomacelectricpower)$/,          "Pepco"],
  [/^(wssc|wsscwater|washingtonsuburban)$/,                   "WSSC"],
  [/^(bge|baltimoregasandelectric|baltimoregaselectric)$/,    "BGE"],
  [/^(dominion|dominionenergy|dominionpower|virginiapower)$/, "Dominion Energy"],
  [/^(fairfaxwater|fairfaxcountywater)$/,                     "Fairfax Water"],
  [/^(novec|northernvirginiaelectric)$/,                      "NOVEC"],
  [/^(smeco|southernmarylandelectric)$/,                      "SMECO"],
  [/^(potomacedison|firstenergy|meted|metedison)$/,           "Potomac Edison"],
  [/^(dcwater|districtofcolumbiawater|dcwasa)$/,              "DC Water"],
  [/^(columbiagas|columbiagaspa)$/,                           "Columbia Gas"],
  [/^(cityofbowie|bowiewater)$/,                              "City of Bowie"],
  [/^(charlescounty|charlescountywater)$/,                    "Charles County"],
  [/^(loudounwater)$/,                                        "Loudoun Water"],
  [/^(arlingtonwater|arlingtoncounty)$/,                      "Arlington Water"],
  [/^(yorkwater)$/,                                           "York Water"],
  [/^(americanwater)$/,                                       "American Water"],
  [/^(pennwaste|pennwastetrash)$/,                            "Penn Waste"],
  [/^(baltimorecity|baltimore|cityofbaltimore)$/,             "Baltimore City"],
  [/^(harfordcounty|hardfordcounty)$/,                        "Harford County"],
];

const strip = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Entity suffixes that must survive: they identify WHICH account.
const SUFFIXES = ["sigma", "utopia", "bluestar", "sycamore", "lavender", "walnut"];

/**
 * "washington GAS" -> "Washington Gas"
 * "bge sigma"      -> "BGE Sigma"      (suffix kept)
 * "Kskso"          -> "Kskso"          (unknown names are returned unchanged)
 */
export function canonicalProvider(raw) {
  const original = String(raw || "").trim();
  if (!original) return original;

  // pull a trailing entity suffix off before matching the base
  let base = original, suffix = "";
  const words = original.split(/[\s(),-]+/).filter(Boolean);
  if (words.length > 1) {
    const last = strip(words[words.length - 1]);
    if (SUFFIXES.includes(last)) {
      suffix = words[words.length - 1].replace(/[(),]/g, "");
      base = words.slice(0, -1).join(" ");
    }
  }

  const key = strip(base);
  for (const [re, name] of CANON) {
    if (re.test(key)) {
      const cap = suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase() : "";
      return suffix ? `${name} ${cap}` : name;
    }
  }
  return original;   // unknown: leave it alone rather than guess
}

/** Do two spellings refer to the same account? Suffix-sensitive. */
export function sameProvider(a, b) {
  return canonicalProvider(a).toLowerCase() === canonicalProvider(b).toLowerCase();
}

/** Base name without the entity suffix, for grouping across LLCs. */
export function providerFamily(raw) {
  const c = canonicalProvider(raw);
  const words = c.split(" ");
  const last = strip(words[words.length - 1]);
  return SUFFIXES.includes(last) ? words.slice(0, -1).join(" ") : c;
}
