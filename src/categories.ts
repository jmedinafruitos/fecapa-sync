import type { Gender, GenderInfo } from "./types.js";

/**
 * Normalised categories. Based on the names seen in the 2021/2022 to
 * 2026/2027 seasons: league names, SIDGAD's own category names and group
 * names. Youth age groups, the senior divisions (Nacional/Primera/Segona/
 * Tercera Catalana, OK Lliga, Lliga Catalana, Supercopa, Copa Generalitat),
 * veterans, and the women's age groups `FEM11` … `FEM19` and `MINIFEM`.
 */
export const CATEGORY_KEYS = [
  "prebenjami", "benjami", "alevi", "infantil", "juvenil", "junior", "senior", "veterans",
  "minifem", "fem11", "fem13", "fem15", "fem17", "fem19", "unknown",
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export type CategoryDefinition = {
  key: CategoryKey;
  /** Display name, in Catalan as the federation writes it. */
  name: string;
  /** `female` for the women's categories (`FEM…`), `unknown` otherwise. */
  gender: Gender;
  /** The mixed age group a women's category corresponds to (`fem13` → `alevi`), or null. */
  ageGroup: CategoryKey | null;
};

export const CATEGORIES: Record<CategoryKey, CategoryDefinition> = {
  prebenjami: { key: "prebenjami", name: "Prebenjamí", gender: "unknown", ageGroup: null },
  benjami: { key: "benjami", name: "Benjamí", gender: "unknown", ageGroup: null },
  alevi: { key: "alevi", name: "Aleví", gender: "unknown", ageGroup: null },
  infantil: { key: "infantil", name: "Infantil", gender: "unknown", ageGroup: null },
  juvenil: { key: "juvenil", name: "Juvenil", gender: "unknown", ageGroup: null },
  junior: { key: "junior", name: "Júnior", gender: "unknown", ageGroup: null },
  senior: { key: "senior", name: "Sènior", gender: "unknown", ageGroup: null },
  veterans: { key: "veterans", name: "Veterans", gender: "unknown", ageGroup: null },
  minifem: { key: "minifem", name: "Minifem", gender: "female", ageGroup: "prebenjami" },
  fem11: { key: "fem11", name: "FEM11", gender: "female", ageGroup: "benjami" },
  fem13: { key: "fem13", name: "FEM13", gender: "female", ageGroup: "alevi" },
  fem15: { key: "fem15", name: "FEM15", gender: "female", ageGroup: "infantil" },
  fem17: { key: "fem17", name: "FEM17", gender: "female", ageGroup: "juvenil" },
  fem19: { key: "fem19", name: "FEM19", gender: "female", ageGroup: "junior" },
  unknown: { key: "unknown", name: "Unknown", gender: "unknown", ageGroup: null },
};

/**
 * Text for matching: accents removed, lower case, dots and apostrophes
 * dropped (`C.P.` → `cp`), anything else that isn't a letter or digit turned
 * into a single space.
 */
export function foldText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.·'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Checked in order on folded text: the more specific patterns first.
// Catalan and Spanish spellings (Aleví/Alevín, Benjamí/Benjamín, Sènior/Sénior…).
const PATTERNS: Array<[RegExp, CategoryKey | ((match: RegExpExecArray) => CategoryKey)]> = [
  [/\bmini ?fem\b/, "minifem"],
  [/\bfem ?(11|13|15|17|19)\b/, (match) => `fem${match[1]}` as CategoryKey],
  [/\bpre ?benjami(n|ns|nes)?\b/, "prebenjami"],
  [/\bbenjami(n|ns|nes)?\b/, "benjami"],
  [/\balevi(n|ns|nes)?\b/, "alevi"],
  [/\binfantil(s|es)?\b/, "infantil"],
  [/\bjuvenil(s|es)?\b/, "juvenil"],
  [/\bjunior(s|es)?\b/, "junior"],
  [/\bveteran(s|os)?\b|\bmaster\b/, "veterans"],
  [/\bsenior(s|es)?\b|\b(nacional|primera|segona|segunda|tercera) catalana\b|\bok (lliga|liga)\b|\b(lliga|liga) catalana\b|\bsupercopa\b|\bcopa generalitat\b/, "senior"],
];

/** The category a name refers to (a league, group or category name, or a user's query), or `unknown`. */
export function categoryOf(name: string | null | undefined): CategoryKey {
  if (!name) return "unknown";
  const folded = foldText(name);
  if (folded === "unknown") return "unknown";
  for (const [pattern, key] of PATTERNS) {
    const match = pattern.exec(folded);
    if (match) return typeof key === "function" ? key(match) : key;
  }
  return (CATEGORY_KEYS as readonly string[]).includes(folded.replace(/ /g, "")) ? (folded.replace(/ /g, "") as CategoryKey) : "unknown";
}

/** A normalised category with the raw name it came from. */
export type NormalizedCategory = { category: CategoryKey; categoryRaw: string | null };

/**
 * The first of `names` that maps to a known category wins (e.g. the league
 * name, then SIDGAD's category name). When none does, the category is
 * `unknown` and the first non-empty name is kept as raw.
 */
export function normalizeCategory(...names: Array<string | null | undefined>): NormalizedCategory {
  for (const name of names) {
    const category = categoryOf(name);
    if (category !== "unknown") return { category, categoryRaw: name! };
  }
  return { category: "unknown", categoryRaw: names.find((name) => name) ?? null };
}

const FEMALE_NAME = /\bfemen(ina|ines|i|ins|ino|inos)\b/;

/**
 * The gender rule. FECAPA has no gender field for teams; this is the domain
 * rule: a `FEM…` category, or a name containing "Femenina" (any accent or
 * case; also "Femení"/"Femenino", the same word in its other forms), is
 * `female`. Everything else is `unknown`, never "male", because youth leagues
 * can be mixed.
 */
export function inferGender(category: CategoryKey | null, names: Array<string | null | undefined> = []): GenderInfo {
  const female = (category !== null && CATEGORIES[category].gender === "female")
    || names.some((name) => typeof name === "string" && FEMALE_NAME.test(foldText(name)));
  return { gender: female ? "female" : "unknown", genderSource: "inferred" };
}
