// job-filters.mjs — STRICT sheet admission rules (per user 2026-07-25).
//
// A job may enter ANY sheet (MASTER workbook tab or HYDERABAD) only if:
//   • its required-experience floor is ≤ 4 years  (user has 4+; JDs demanding 5+ are noise)
//   • it is not an Azure-centric role             (user's stack is AWS)
// Both checks fail-open ONLY when the signal is genuinely absent — a job with no
// parsable experience text is kept (missing a real DevOps opening is worse than
// showing one row too many), but any parsable floor > 4 is rejected.

// Parse the minimum years of experience demanded by a text blob (exp field + title).
// Handles: "5-10 yrs", "5 to 8 years", "5+ years", "minimum 6 years", bare "5 yrs", "7 YOE".
export function expFloor(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  let lo = null;
  const keep = (n) => { if (n <= 40) lo = lo === null ? n : Math.min(lo, n); };
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?|yoe)\b/g)) keep(+m[1]);
  if (lo === null) for (const m of t.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?|yoe)\b/g)) keep(+m[1]);
  return lo;
}

// The experience floor stated INSIDE the JD body, read only from an explicitly
// LABELLED overall-experience statement ("Minimum 5 Year(s) Of Experience Is Required",
// "Experience: 6-9 Years", "8+ years of progressive experience").
//
// Why labelled-only (2026-10-14 lesson): a JD body names years constantly ("3+ years of
// Docker", "2 years of Terraform"). Taking the min of every year mention in the body
// would reject real in-band roles on a single per-skill line. Only a statement that
// labels itself as THE overall experience requirement counts here.
//
// Why this is needed at all (Tekskills lesson, 2026-10-14): THE PORTAL HEADER BAND LIES.
// naukri advertised "4-8 yrs" in its exp field while the JD body said "Experience: 5-7
// Years"; Accenture reqs routinely carry no header band at all while the body states
// "Minimum 5 Year(s) Of Experience Is Required". The body is the employer's own words,
// so when it states an overall floor it OUTRANKS the header band.
const TRAILING_HEDGE =
  /\b(?:is\s+)?(?:preferred|desirable|a\s+plus|nice\s+to\s+have|good\s+to\s+have|advantageous|an\s+advantage)\b/i;
const BODY_EXP_PATTERNS = [
  // POST-MODIFIED floor (2026-10-30) — closes [[gate-blindspot-postmodified-exp-floors]].
  // Every other pattern here reads "N years of experience"; a domain noun inserted between
  // "years of" and "experience" ("7+ years of ServiceNow Platform experience", "5+ years of
  // automation experience", "6+ years of BI/analytics experience") defeated all of them, so
  // those reqs read as having NO floor. Mondelez talent-626348144839098896 was the trigger: a
  // 7+ yr ServiceNow seat at 100% ATS and a green gate.
  //
  // This is NOT the deliberately-unguarded band in [[gate-blindspot-5to7-domain-floors]] —
  // that one is "5+ years of experience WITH AWS" (experience BEFORE the domain) and still
  // parses to null here, verified. This pattern only fires when the domain PRECEDES the word
  // "experience".
  //
  // Four guards, every one of them paid for by a measured false reject in this same pass:
  //   • (?<![-–]\s*) / (?<!\d\s*[-–]\s*) — never read a written range's upper bound as the floor.
  //   • (?<!\d\s{1,3}) — naukri and talent.com STRIP range hyphens, so "4-7 years" arrives as
  //     "4 7 years". Without this, iOPEX 221026034099 (4-7, in band) and Infosys
  //     talent-633748169191196361 (3-5, in band) were both falsely rejected on their upper bound.
  //   • (1[0-5]|[1-9]) caps the figure at 15 — a stripped range can also arrive GLUED
  //     ("3-5 years" -> "35 years"). Fold Health 290726500478 and Inswit 051026022686 read as
  //     35-yr floors and Tekion 070926005979 as 23; the generic n>40 bound let all three
  //     through. No real floor is >15, and anything that senior is caught by grade rules anyway.
  // Measured on 2712 passing rows: 15 flips before the guards (5 false), 9 after — all 9 are
  // genuine 5+ floors, eyeballed one by one (Nightfall, Blue Yonder, Marriott, Acunor,
  // SportAtlas, Wells Fargo, Smart Working, LTM, Jobgether).
  /(?<![-–]\s*)(?<!\d\s*[-–]\s*)(?<!\d\s{1,3})(?<!\d\s+to\s+)(?<!\d)(1[0-5]|[1-9])\s*\+?\s*(?:years?|yrs?)\s+of\s+(?:[\w\/&-]+\s+){1,3}experience\b/gi,
  /(?:total|overall|relevant)?\s*(?:work\s+)?experience\s*(?:required)?\s*[:\-–]\s*(\d{1,2}(?:\.\d)?)\s*(?:\+|-|–|to)?\s*(?:\d{1,2}(?:\.\d)?)?\s*\+?\s*(?:years?|yrs?)/gi,
  // Decimal floor (2026-10-27 lesson): Accenture's house phrasing is "Minimum 7.5 Year(s) of
  // experience is required". Without (?:\.\d)? the "7" matched but ".5" broke the "years"
  // anchor, so the whole pattern fell through and a 7.5-yr seat read as having NO floor.
  /minimum\s+(?:of\s+)?(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:year|yr)\(?s?\)?\s+(?:of\s+)?(?:\w+\s+){0,3}?experience\s+is\s+required/gi,
  // Range form FIRST — "a minimum of 4 - 7 years of professional experience" and
  // "2 to 5 years of professional experience" have a floor of 4 and 2, not 7 and 5.
  // 2026-10-30: the qualifier class was \w+, which cannot match a HYPHENATED qualifier, so
  // Fractal's "8–12 years of hands-on experience in DevOps" (talent.com) parsed to null and an
  // 8-12 yr Lead seat cleared the gate at 87% ATS. [\w/-]+ also covers "end-to-end" and "BI/ops".
  /(\d{1,2}(?:\.\d)?)\s*(?:-|–|to)\s*\d{1,2}(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\s+of\s+(?:[\w\/-]+\s+){0,2}?experience/gi,
  // Reversed word order: "Total experience of 4-5+ years", "minimum experience of 6-8 years".
  // Every pattern above reads "<N> years of experience"; none read "experience of <N> years",
  // so a req stating its floor that way was INVISIBLE (2026-10-24: SonicWall's "Total
  // experience of 4-5+ years" parsed to null, as did "Total experience of 6-8 years").
  // Label required (total/overall/relevant/minimum) to stay inside this file's labelled-only
  // rule — bare "experience of 3 years in Docker" is a per-skill line, not an overall floor.
  // Lower bound of the range is the floor, same as the range form above.
  /(?:total|overall|relevant|min(?:imum)?)\s+(?:work\s+)?experience\s+of\s+(\d{1,2}(?:\.\d)?)\s*(?:\+|-|–|to)?\s*(?:\d{1,2}(?:\.\d)?)?\s*\+?\s*(?:years?|yrs?)/gi,
  // Single-figure forms. RANGE_GUARD stops them re-reading a range's upper bound as a floor
  // (2026-10-14 lesson: Comviva's "2 to 5 years of professional experience" and Spydra's
  // "minimum of 4 - 7 years" were both wrongly killed as 5-yr and 7-yr floors).
  /(?<!\d\s*[-–]\s*)(?<!\d\s+to\s+)(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+of\s+(?:overall|total|professional|relevant|progressive)\s+experience/gi,
  /(?:should|must)\s+have\s+(?:a\s+)?minimum\s+(?:of\s+)?(?<!\d\s*[-–]\s*)(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi,
  /minimum\s+(?:of\s+)?(?<!\d\s*[-–]\s*)(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+of\s+experience\s+in\b/gi,
  /(?:requires?)\s+(?:a\s+)?minimum\s+(?:of\s+)?(?<!\d\s*[-–]\s*)(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi,
  // "<N> yrs of hands-on ..." (2026-10-29). SMART IT PROS' remote DevOps contract buries its
  // floor mid-sentence with no label and no space after the comma: "maintaining infrastructure
  // as code (IaC),7 yrs of hands-on IAAC development using Ansible, Terraform, AWS cli". At 7
  // it sits below HIGH_FLOOR_MIN, so nothing caught it and the row cleared the gate at 100% ATS.
  // Restricted to the "yrs" ABBREVIATION, which shows up in terse must-have lines rather than
  // the per-skill prose ("3+ years of Docker experience") the labelled-only rule guards against.
  // RANGE_GUARD is mandatory here: without it Veena World's in-band "4 - 6 Yrs of hands-on
  // experience in DevOps / Cloud" read as a 6-yr floor — the RANGE_UPPER regression again.
  // With the guard this matches exactly one row across all 7 scan files.
  /(?<!\d\s*[-–]\s*)(?<!\d\s+to\s+)(\d{1,2})\s*\+?\s*yrs\.?\s+of\s+hands-?on\b/gi,
  // Structured "Experience Level:" field (2026-10-29). The first pattern above reads
  // "experience ... : <N> years", but the word "Level" sits between "experience" and the
  // colon, so KSB Tech's header — "Department: FCI-CX82  Experience Level: 5+ years" —
  // parsed to NO floor and the req cleared the gate at 93% ATS. An explicitly labelled
  // structured field, so there is nothing to confuse it with: 7 JD matches across all 7
  // scan files, 6 of them in-band and unaffected.
  // "Range" joins "Level" here (2026-10-29): The Edge Partnership's Hyderabad req states
  // "Location: Hyderabad / Remote  Experience Range: 6yrs - 11yrs" and sat green at 88% ATS,
  // because "Range" occupies the same slot between "experience" and the colon that "Level"
  // does. Same structured-field shape, same safety: 2 JD matches corpus-wide, 1 in band and
  // untouched, 1 flip (that Edge req, floor 6). The range's LOW end is captured as the floor.
  /experience\s+(?:level|range)\s*[:\-–]\s*(\d{1,2}(?:\.\d)?)\s*(?:\+|-|–|to)?\s*(?:\d{1,2}(?:\.\d)?)?\s*\+?\s*(?:years?|yrs?)/gi,
  // "Minimum of <N> years of <qualifier> experience in ..." (2026-10-29). The bare
  // "minimum ... years of experience in" pattern above requires "of" to butt straight against
  // "experience", so one adjective defeated it: Ryan Specialty's "Minimum of 5 years of
  // CUMULATIVE experience in Site Reliability Engineering, DevOps, Systems Engineering/Ops"
  // parsed to no floor and cleared the gate at 83% ATS (and again on two weekday reposts of
  // the same req). Still anchored on the word "minimum", so it stays inside the labelled-only
  // rule — the qualifier window is 1-2 words, not open-ended. Measured: 27 JD matches, 7 in
  // band and untouched, 2 pass=true flips (both the Ryan Specialty duplicates).
  /minimum\s+(?:of\s+)?(?<!\d\s*[-–]\s*)(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+of\s+(?:\w+\s+){1,2}experience\s+in\b/gi,
  // Label-then-range with NO separator: "Work Experience 7-10Years", "Experience 8–12 Years",
  // "Years of Experience 5 to 10 years" (2026-10-29). The first pattern in this list requires a
  // ":" or "-" after the label, so every req that writes the band as a bare structured header
  // was invisible — TCS's "Senior Site Reliability Engineer (GCP Platform & Kubernetes)
  // Experience 8–12 Years" and Virtusa's Hyderabad "Work Experience 7-10Years" both cleared
  // the gate (84% and 88% ATS).
  //
  // Safe despite having no label keyword because the word "experience" must sit IMMEDIATELY
  // before the figure, which is a header idiom, not prose — a per-skill line reads the other
  // way round ("3+ years of Docker experience"). Measured over all 7 scan files: 46 JD matches,
  // 34 of them in band (floors 0-4) and left alone, 1 pass=true flip (Virtusa, floor 7). All
  // 25 sampled matches were genuine overall-experience headers; zero false reads.
  //
  // Needs no RANGE_UPPER guard: the capture group is the range's LOW end by construction.
  // Will not fire on hyphen-STRIPPED ranges ("Experience 5 8 years" from naukri/talent) — a
  // separator is required on purpose, since without one the two figures cannot be told apart
  // from a fake 58-yr floor (cf. the Shine "3 - 7" lesson).
  /\bexperience\s+(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)/gi,
  // Title-header band: "DevOps Engineer | 5-10 Years", "Senior DevOps Engineer (Azure) | 4-8
  // Years" (2026-10-29). HCL's req states its floor ONLY in the piped title line, with no
  // "experience" word anywhere near it, so it cleared the gate at 100% ATS on two separate
  // postings (HCLTech and HCL TechBee).
  //
  // The literal "|" immediately before the figure is what makes this safe to read without a
  // label — it is a title-line delimiter, not prose. Measured: 13 JD matches, 9 in band and
  // untouched (Recro 1-2, CloudSutra 2-6, Infosys 3-15, ADP 3-6, EY 4-8, Codelynks 1-3,
  // NEXUS 2-3, programmers.io 4-9, Success Pact 4-8), 0 current pass=true flips — this one is
  // prospective insurance plus the two HCL rows, both already marked Skip by hand this pass.
  // LOW end captured, so no RANGE_UPPER guard needed here either.
  /\|\s*(\d{1,2})\s*(?:-|–)\s*\d{1,2}\s*(?:years?|yrs?)/gi,
  // Parenthetical floor glued to the job title: "Site Reliability Engineer (6+ Years)",
  // "DevOps Engineer (6+ years)", "SRE Exposure (5-15 Yrs)" (2026-11-03). Same shape as the
  // "|" title-header band above — a delimiter stands in for the word "experience" — but with
  // parentheses instead of a pipe, so none of the patterns above could see it. HighRadius
  // writes its whole band this way and nothing else in the JD states a floor: its two
  // Hyderabad "Site Reliability Engineer" reqs (6+ and 7+) carry a clean, unprefixed,
  // DevOps-family title in Nikhil's target city and read as having NO floor, which is the
  // worst possible combination. Found by enumerating boards-api.greenhouse.io/highradius in
  // full while the naukri repost of the same req sat green at 81% ATS.
  //
  // Safe to read without a label for the same reason the "|" pattern is: a bare "(N years)"
  // with the closing paren required is a title/header idiom, not prose — a per-skill line
  // reads the other way round ("3+ years of Docker experience"). The closing ")" is what
  // keeps it tight; without it this would eat "(including 5 years of leadership ...)".
  //
  // Measured over all 7 scan files: 119 JD matches, 51 of them in band (floors 1-4) and left
  // alone, 3 pass=true flips — Simeio devops 4410570430 "DevOps Engineer (6+ years)" at 83%,
  // HighRadius naukri 080926011826 "Site Reliability Engineer (7+ Years)" at 81%, and
  // TEKsystems websearch talent-619321703647222882 "SRE Exposure (5-15 Yrs)" at 88%. All
  // three eyeballed as genuine overall floors; zero false rejects in the 119.
  //
  // LOW end captured on a range, so no RANGE_UPPER guard is needed.
  /\(\s*(\d{1,2})\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs?)\.?\s*\)/gi,
  // "At least <N> years of experience" (2026-10-29). This is the must-have idiom in the PwC
  // and Blue Yonder templates ("What You Must Have • At least a Bachelor's degree • At least
  // 5 years of experience") and it ends at the bare word "experience" with no label and no
  // domain, so every pattern above missed it: P&G Hyderabad's "At least 5 years of experience
  // working with Azure Cloud/GCP/AWS" cleared the gate at 87% ATS.
  //
  // Measured over all 7 scan files: 69 JD matches, 27 of them in band (floors 1-4) and left
  // alone, 18 admitted rows newly rejected. Every flip spot-checked as a genuine overall
  // floor — AlgoSec x10 "At least 5 years of experience in DevOps roles", Blue Yonder x5
  // "At least 5+ years of experience in technology roles", PwC x2, nopalcyber. The pattern
  // discriminates WITHIN one employer's template: PwC reqs 4432978421 and 4478697692 state
  // "at least 4 years" and correctly stay green.
  //
  // CAVEAT: bodyExpFloor returns the HIGHEST match in a JD (hi = Math.max), so a req that
  // states "at least 2 years of experience in DevOps" alongside "at least 7 years of
  // experience in leadership" floors at 7, not 2. No such row exists across the 69 current
  // matches — re-verify this with the full-corpus diff below before widening the pattern.
  /at\s+least\s+(?<!\d\s*[-–]\s*)(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\s+of\s+experience\b/gi,
  // Range + "years IN <discipline>", with no "experience" word anywhere near the figures
  // (2026-11-03). The preposition is the whole bug: "6-15 years OF DevOps experience" is
  // already caught by the label/`experience`-adjacent patterns above, but "8 –15 years IN
  // DevOps, cloud or platform engineering" matched nothing and cleared the gate. Found on
  // Deloitte South Asia `61190144` (T&T|EAD|HCE|Senior Consultant|AWS Devops|Mumbai), which
  // states its band twice — "Experience: 7–12 years" caught it, but a req that only wrote
  // the "8 –15 years in DevOps" line would have passed at a 10-AWS-token 90%+ ATS.
  //
  // Safe without a label keyword because a KNOWN DISCIPLINE NOUN must follow "years in" —
  // that is an overall-experience idiom, not prose. Deliberately does NOT include bare
  // "years in" (which would eat "3-5 years in a fast-paced environment", a non-floor).
  //
  // Measured over all 7 scan files: 76 JD matches, 62 of them in band (floors 0-4) and left
  // alone, 14 would-reject — and ALL 14 are ALREADY pass=false, so zero current flips and
  // zero regressions. Prospective insurance, same class as the `|`-delimiter pattern above.
  // Spot-checked flips are all genuine overall floors: SmartDocs "5 - 10 years in DevOps" x2,
  // Charger Logistics "6–8 years in SRE" x3, nCircle Tech "6–8 years in DevOps" x3, Birlasoft
  // "6–12 years in cloud", SimCorp "5–8+ years in Site Reliability", Tenarai "5–7 years in
  // cloud", FPL Technologies "5-8 years in DevOps", armor defense "6–10 years in SRE".
  //
  // LOW end captured by construction, so no RANGE_UPPER guard is needed.
  /(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+in\s+(?:devops|sre|site\s+reliability|cloud|platform|infrastructure|production\s+engineering)\b/gi,
];

// High floors (>= HIGH_FLOOR_MIN yrs) stated WITHOUT one of the "overall/total/relevant"
// labels the patterns above require (2026-10-24 lesson, TNS + 18 others): a req can read
// "10+ years of DevOps and Test Engineering experience" or "Exp - 8 + Years" and clear the
// whole gate at 92% ATS, because the qualifier between the figure and the word "experience"
// is a DOMAIN ("DevOps and Test Engineering"), not a label. Nineteen rows were sitting at
// 🟢 pass=true on 8-15 yr reqs when this was found.
//
// Scoped to >= 8 yrs on purpose. Below that, "N+ years of X experience" is routinely a
// PER-SKILL line ("3+ years of Docker experience") on a perfectly in-band req, which is
// exactly the over-matching the labelled-only rule above exists to prevent. At 8+ there is
// no in-band reading left — a seat asking 8 years of anything is out of band for ~3.5 yrs.
const HIGH_FLOOR_MIN = 8;
const HIGH_FLOOR_PATTERNS = [
  /(\d{1,2})\s*\+\s*(?:years?|yrs?)\s+of\s+(?:[\w\/&(),.-]+[\s]+){0,6}?experience/gi,
  /\bexp(?:erience)?\s*[-:–]\s*(\d{1,2})\s*\+\s*(?:years?|yrs?)/gi,
];
// "8 or more years of software engineering experience" / "10 years or more": the same hard
// floor as "8+ years", written without the plus sign, so every pattern above misses it
// (2026-10-27: Codvo.ai "Senior Edge Platform Engineer" sat at 🟢 pass=true / 100% ATS on an
// 8-yr floor because each high-floor pattern required a literal "+").
//
// Kept SEPARATE from HIGH_FLOOR_PATTERNS because only these need the RANGE_UPPER guard: the
// "or more" phrasing attaches to the TOP of a spliced range ("Specialist(5 to 8 Years or
// more)" from a talent.com Promoted card), whereas applying that guard to the "+" patterns
// re-opened a real 5-yr floor (L&T "5 to 8+ years of enterprise-level Devops experience").
const HIGH_FLOOR_OR_MORE = [
  /(\d{1,2})\s+or\s+more\s+(?:years?|yrs?)/gi,
  /(\d{1,2})\s*(?:years?|yrs?)\s+or\s+more/gi,
];
// Aggregator "related jobs" rails read "<City> · 8+ yrs <Other Title>" and get spliced into
// the JD body (same contamination class as the talent.com splice). A middot just before the
// figure means we are reading SOMEONE ELSE'S req — Hiver ("Experience 3+ yrs"), Securonix and
// Innovature were all wrongly killed by a rail hit before this guard went in.
const SIDEBAR_RAIL = /·[^.\n]{0,20}$/;
// "5 to 8 Years", "3-8", "3 – 8": the figure we matched is the range's TOP, not its floor.
const RANGE_UPPER = /\d{1,2}\s*(?:to|[-–])\s*$/;
// Hedged floors ("10+ years preferred", "8 years is a plus") are aspirations, not gates.
// The hedge lookback is scoped to the floor statement's OWN LINE, not a flat 150-char
// window (2026-10-14 lesson): Accenture's req template puts "Good to have skills : NA" two
// fields above "Minimum 5 Year(s) Of Experience Is Required", and a window that crosses the
// newline let an unrelated field's hedge cancel a real, hard floor.
//
// Naukri serves that same Accenture template as ONE newline-free blob, which made the
// "own line" guard degenerate back into the flat window it was meant to replace (2026-10-27
// lesson: "…Good to have skills :Python (Programming Language)Minimum 7.5 year(s) of
// experience is required" — the hedge three fields away cancelled a hard 7.5-yr floor on 7
// live Accenture rows). Concatenated template fields leave a run-on seam, lowercase or ")"
// butted straight against a capitalised next field, so treat that seam as a line break too.
// Scoped to the seam only: real prose hedges ("Nice to have: 8 years of X") have no seam and
// still cancel as before.
const FIELD_SEAM = /[a-z)\]](?=[A-Z])/g;
// `next` is the first character of the floor statement itself. Without it the seam that
// matters most — the one immediately before the floor, as in "(Programming Language)Minimum"
// — sits at the very end of the lookback window with its capital on the far side, and the
// lookahead can never see it.
// An ALL-CAPS field value leaves no seam to find ("Good to have skills :NAMinimum 7.5
// year(s)…" — "A" then "M", both capitals). But a hedge field whose value is literally NA
// cannot hedge anything, so drop those labels outright before the hedge test rather than
// trying to seam-split them.
const EMPTY_HEDGE_FIELD =
  /(?:nice|good)[\s-]to[\s-]have[^:\n]{0,30}:\s*(?:NA|N\/A|None|-)(?![a-z])/gi;
function hedgeScope(window, next = "") {
  let cut = window.lastIndexOf("\n") + 1;
  for (const m of (window + next).matchAll(FIELD_SEAM)) cut = Math.max(cut, m.index + 1);
  return window.slice(Math.min(cut, window.length)).replace(EMPTY_HEDGE_FIELD, "");
}
export function bodyExpFloor(jd) {
  if (!jd) return null;
  const t = String(jd);
  let hi = null;
  for (const re of BODY_EXP_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const n = +m[1];
      if (n < 1 || n > 40) continue;
      const window = t.slice(Math.max(0, m.index - HEDGE_WINDOW), m.index);
      const before = hedgeScope(window, m[0][0]); // same line / same template field only
      if (HEDGE_NEARBY.test(before)) continue;
      // Experience hedges usually TRAIL the figure ("10+ years ... is preferred"), which a
      // backward-only window never sees — check the rest of the same line too.
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + HEDGE_WINDOW).split("\n")[0];
      if (TRAILING_HEDGE.test(after)) continue;
      hi = hi === null ? n : Math.max(hi, n);
    }
  }
  if (hi !== null) return hi;
  for (const re of HIGH_FLOOR_OR_MORE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const n = +m[1];
      if (n < HIGH_FLOOR_MIN || n > 40) continue;
      if (SIDEBAR_RAIL.test(t.slice(Math.max(0, m.index - 25), m.index))) continue;
      // Never read the TOP of a range as the floor ("5 to 8 Years or more") — the floor is
      // the low end, and in a spliced aggregator card it is not even this req's floor.
      if (RANGE_UPPER.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + HEDGE_WINDOW).split("\n")[0];
      if (TRAILING_HEDGE.test(after)) continue;
      hi = hi === null ? n : Math.max(hi, n);
    }
  }
  if (hi !== null) return hi;
  for (const re of HIGH_FLOOR_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const n = +m[1];
      if (n < HIGH_FLOOR_MIN || n > 40) continue;
      if (SIDEBAR_RAIL.test(t.slice(Math.max(0, m.index - 25), m.index))) continue;
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + HEDGE_WINDOW).split("\n")[0];
      if (TRAILING_HEDGE.test(after)) continue;
      hi = hi === null ? n : Math.max(hi, n);
    }
  }
  return hi;
}

// True when the job's experience floor exceeds maxYears (default 4).
// Also reads the processed insight text — scanners often leave exp blank while the
// JD-fit insight already states the real requirement ("wants 7-10 yrs").
// The JD body's own labelled floor WINS over the portal header band when present.
export function tooSenior(job, maxYears = 4) {
  const body = bodyExpFloor(job.jd);
  if (body !== null) return body > maxYears;
  const floor = expFloor(`${job.exp || ""} ${job.title || job.role || ""} ${job.insight || ""}`);
  return floor !== null && floor > maxYears;
}

// Grades that are structurally out of band for a ~3.5-yr engineer, read from the TITLE
// (2026-10-14 lesson, found the hard way across three sweeps): a req can score 100% ATS,
// clear every stack check and still be unreachable because it is a people-leadership or
// staff-plus seat. Optum's "Director Software Engineering" (ats=78, gate PASS) wanted 14+
// yrs; Crowe's "DevOps Engineering Manager" (ats=87, gate PASS) wanted 8+. Stack overlap
// is real on these — that is exactly why ATS cannot catch them and the title must.
//
// "Assistant Manager" is deliberately NOT a kill: in Indian bank/GCC grade ladders it is a
// junior-to-mid rung (BNP Paribas "Assistant Manager - Cloud Platform Engineer" states no
// year floor at all), so it fails open like every other ambiguous signal in this file.
// "Assistant/Associate Vice President" IS a kill — AVP is an 8-yr-plus rung at the same banks.
const OUT_OF_BAND_GRADE =
  /\b(?:director|vice\s+president|vp|chief|head\s+of|principal|distinguished|fellow|senior\s+manager|engineering\s+manager|group\s+manager|cto|cio)\b/i;
// Manager-titled roles that are individual-contributor job families, not a grade.
const IC_MANAGER_FAMILY =
  /\b(?:release|configuration|incident|change|asset|product|program|project|account|category|key)\s+manager\b/i;
const ASSISTANT_MANAGER = /\bassistant\s+manager\b/i;
export function isOutOfBandGrade(job) {
  const title = String(job.title || job.role || "");
  if (ASSISTANT_MANAGER.test(title) && !OUT_OF_BAND_GRADE.test(title.replace(ASSISTANT_MANAGER, ""))) return false;
  if (OUT_OF_BAND_GRADE.test(title)) return true;
  return /\bmanager\b/i.test(title) && !IC_MANAGER_FAMILY.test(title);
}

// True for Azure-centric roles: Azure in the title, a skills/tags list that names
// Azure but not AWS, or an insight that states the stack IS Azure. Multi-cloud JDs
// that merely LIST azure as one keyword among many ("minor gaps: azure") stay in —
// dropping those would silently cost real AWS-friendly Hyderabad openings.
const AZURE_STACK =
  /(?:cloud|stack|platform|environment)\s+is\s+azure|azure\s*\+\s*gcp|azure[-\s](?:only|centric|based|first|heavy|focused)|primarily\s+azure/gi;
export function isAzureJob(job) {
  const title = String(job.title || job.role || "");
  if (/\bazure\b/i.test(title)) return true;
  const skills = [job.skills, job.tags, job.keywords]
    .flat().filter(Boolean).map(String).join(" ").toLowerCase();
  if (skills && /\bazure\b/.test(skills) && !/\baws\b|\bamazon web services\b/.test(skills)) return true;
  if (azureStackStated(String(job.insight || ""))) return true;
  // JD BODY, 2026-10-29: the three checks above read only the title, the skills/tags array
  // and our own insight line, so a JD whose BODY is wall-to-wall Azure sailed through as a
  // green. This is the blindspot the 2026-10-28 pass found and left unfixed (qloron,
  // talent-633391403829108488: 35 Azure mentions, 0 AWS, PASS on title/skills alone). Same
  // shape, same thresholds and the same AWS_ADJACENT guard as the GCP body rule below.
  //
  // The one extra guard Azure needs and GCP does not: "Azure DevOps" (and Repos/Pipelines/
  // Boards/Artifacts) is a CI/CD TOOL, and "Azure AD"/"Entra" is an identity provider —
  // both are routinely used to ship onto AWS. Counting them as cloud mentions would wrongly
  // reject 20 measured rows whose Azure hits are ALL tool mentions (RealPage x2, Hitachi
  // Energy, Accenture x5, LanceSoft, Techcarrot x3, NielsenIQ, Davies, ADM, SRS Infoway,
  // Autorabit, MetLife Jr., hirist 1646984). Strip the tool forms, then count.
  //
  // Flips 123 of 3614 admitted rows (3.4%); spot-checked Azure-primary across the range
  // (Microsoft SWE-II az=17, MetLife SRE family az=5, Techwave Puppet "Linux + Puppet +
  // Azure Cloud", Hitachi Vantara AKS/Azure-AD/Azure-backup, RSM "1+ yrs Azure Public
  // Cloud", ADV TECHMINDS "greenfield Kubernetes environment in Azure", Accenture
  // "Must have skills : Microsoft Azure PaaS").
  //
  // A sentence-spread guard (require the hits in 2+ sentences) was TESTED AND REJECTED: it
  // spares only 3 rows and two of them are genuine Azure-only seats (RSM US x2), while the
  // one row it was meant to save — AssetMark 4469690184, whose 3 hits sit inside a single
  // "Azure (e.g. API Management, Service Bus, Event Grid) ... is a plus" clause — is split
  // across sentences by any splitter and flips either way. That row is already Borderline
  // at 67% ATS on a Java/Spring Boot seat, so the miss costs nothing.
  const jd = String(job.jd || "");
  if (jd.length > 400) {
    const low = jd.toLowerCase();
    const azureHits = (low.replace(AZURE_TOOL, " ").match(/\bazure\b|microsoft azure/g) || []).length;
    const awsHits = (low.match(/\baws\b|amazon web services/g) || []).length;
    if (azureHits >= 3 && awsHits === 0 && !AWS_ADJACENT.test(low)) return true;
  }
  return false;
}

// "Azure DevOps"/Repos/Pipelines/Boards/Artifacts = the ADO toolchain; "Azure AD"/"Azure
// Active Directory"/"Azure Entra" = identity. Neither names the seat's cloud.
const AZURE_TOOL =
  /\bazure\s+(?:devops|repos|pipelines?|boards|artifacts|ad\b|active\s+directory|entra)/g;

// AZURE_STACK reads our OWN insight line, so a note that NEGATES or ATTRIBUTES the phrase
// re-triggers it (2026-10-29, same insight-echo family as the quoted-citation skip in
// isWrongCore). Two live false positives, both on rows a prior pass had marked pass=true:
//   - Alphacom shine-19933412: "(Azure DevOps as the tool, not Azure-only) — apply" — the
//     regex matched the very phrase being denied. Its JD is Jenkins/Terraform/Ansible.
//   - Okta okta-8263918: "...alongside AWS and Nikhil's second cloud is Azure" — "cloud is
//     Azure" describes NIKHIL's stack, not the seat's. That JD names AWS 6x and K8s 9x.
// Measured over all 7 scan files: 189 AZURE_STACK insight matches, exactly these 2 exempted.
const AZURE_NEGATED = /\b(?:not|isn'?t|rather\s+than|instead\s+of|never)\s+(?:\w+\s+){0,3}$/i;
const AZURE_CANDIDATE = /\b(?:nikhil|candidate|his|her|their|my)(?:'s)?\s+(?:\w+\s+){0,3}$/i;
function azureStackStated(insight) {
  AZURE_STACK.lastIndex = 0;
  let m;
  while ((m = AZURE_STACK.exec(insight))) {
    const before = insight.slice(Math.max(0, m.index - 60), m.index);
    if (AZURE_NEGATED.test(before) || AZURE_CANDIDATE.test(before)) continue;
    return true;
  }
  return false;
}

// Explicit "Must have skills :" declaration (Accenture/Talent500 JD template, 2026-10-14g).
// These JDs state their one required skill in a structured field — "Must have skills :Google
// Cloud Platform (GCP)Good to have skills :NA" — and that field is the seat's primary cloud,
// not an incidental mention. Returns the must-have text only, so a cloud named anywhere else
// in the body (a hosted workload, a migration source) can never trigger a reject.
const MUST_HAVE_BLOCK =
  /must[\s-]have\s+skills?\s*:?\s*(.{0,200}?)(?:good[\s-]to[\s-]have|minimum\s|educational|summary\s*:|$)/is;
export function mustHaveSkills(job) {
  const m = MUST_HAVE_BLOCK.exec(String(job.jd || ""));
  return m ? m[1] : "";
}

// GCP-centric roles (same logic as Azure): GCP in the title, or a stack that names
// GCP but not AWS. "AWS or GCP" multi-cloud JDs stay in.
export function isGcpJob(job) {
  const title = String(job.title || job.role || "");
  if (/\bgcp\b|google\s+cloud/i.test(title)) return true;
  const skills = [job.skills, job.tags, job.keywords]
    .flat().filter(Boolean).map(String).join(" ").toLowerCase();
  if (skills && /\bgcp\b|google cloud/.test(skills) && !/\baws\b|\bamazon web services\b/.test(skills)) return true;
  if (/(?:cloud|stack|platform|environment)\s+is\s+gcp|gcp[-\s](?:only|centric|based|first)/i.test(String(job.insight || ""))) return true;
  // A structured "Must have skills" field naming GCP and not AWS: the declared primary
  // cloud is one cv.md greps ZERO times (gcp: 0, google cloud: 0, vs aws: 12, azure: 5).
  // Caught 3 Accenture greens at 83/83/75 that scored on generic CI/CD vocabulary alone.
  const must = mustHaveSkills(job);
  if (must && /\bgcp\b|google\s+cloud/i.test(must) && !/\baws\b|amazon\s+web\s+services/i.test(must)) return true;
  // JD BODY, 2026-10-28 (Anaqua lesson): the four checks above read only the title, the
  // skills/tags array, our own insight line and the structured "Must have skills :" field.
  // A JD whose BODY is wall-to-wall GCP sailed through all of them at 85% ATS and sat on
  // the sheet as a green — Anaqua "Senior Platform Engineer (Infrastructure & DevOps)",
  // 7 GCP mentions, 0 AWS, GKE/GitLab-CI/Pub-Sub/Cloud-SQL — while its near-identical
  // sibling "Senior Platform Engineer (Java + GCP)" was rejected purely because its title
  // happened to spell GCP. Same seat, same stack, opposite verdicts.
  //
  // Thresholds are deliberately conservative, measured over all 2794 passing rows:
  //   - jd.length > 400 skips truncated/portal-stub JDs, where absence proves nothing.
  //   - 3+ GCP mentions, not 1: a single "AWS/GCP/Azure" laundry-list line is not a stack.
  //   - AWS_ADJACENT guard: "Amazon EKS"/EC2/S3/Lambda/CloudFormation name the seat's real
  //     cloud even when the literal token "AWS" never appears. Without it, QuillBot and
  //     MOTTO HR (both CloudFormation JDs) would have been wrongly rejected.
  // Flips 47 of 2794 greens (1.7%); every one spot-checked GCP-only (HSBC "GCPDevops, GKE",
  // PwC "GCP Devops Engineer", Google "Cloud Engineer, AI", GlobalLogic IRC302637).
  const jd = String(job.jd || "");
  if (jd.length > 400) {
    const low = jd.toLowerCase();
    const gcpHits = (low.match(/\bgcp\b|google cloud/g) || []).length;
    const awsHits = (low.match(/\baws\b|amazon web services/g) || []).length;
    if (gcpHits >= 3 && awsHits === 0 && !AWS_ADJACENT.test(low)) return true;
  }
  return false;
}

// AWS service names that identify the seat's cloud even when the token "AWS" is absent.
const AWS_ADJACENT = /\bec2\b|\bs3\b|\beks\b|\becs\b|\bcloudformation\b|\bcloudwatch\b|\blambda\b|amazon/;

// Wrong-core roles hiding under a DevOps title: VMware/data-centre sysadmin,
// Windows/.NET ops, mainframe. His stack has zero overlap — a JD that names these
// in its text is an infrastructure-ops seat, not cloud DevOps (ARRISE lesson, 2026-07-27).
// Go Lang added 2026-07-28 (GE lesson): AWS/EKS/Kubernetes appearing in a JD does not
// make it DevOps when the must-have #1 is "experience working on Go Lang" and the
// responsibilities are core software engineering ("writes code... data structures and
// algorithms") — that is an application-development seat that happens to deploy on AWS,
// not an infra/DevOps seat. He has zero Go experience, same zero-overlap logic as VMware.
//
// Hedge-aware, 2026-07-29 (150-job re-audit lesson): a blind substring match rejected 52
// genuinely strong AWS/DevOps matches — e.g. an "AWS SRE" role naming EC2/VPC/IAM/Terraform/
// Prometheus throughout, downgraded only because "VMware" appeared once under a "Good To
// Have" bullet 87 chars earlier, or "Familiarity with Golang" / "knowledge of Python or
// Golang" as one optional line among real DevOps requirements. A single hedged mention
// ("good to have", "nice to have", "familiar with", "knowledge of X or Y", "is a plus",
// "optional", "preferred", "desirable") is not the job's core — only an UNHEDGED mention
// (a real must-have, like GE's "Experience working on Go Lang" or HPE's "Strong programming
// skills in Golang") should reject.
// Enterprise-database / Oracle-engineered-systems core (2026-10-29 lesson). Three Oracle
// "Senior Site Reliability Engineer" reqs (4482565720 / 4482564724 / 4482574174) sat at
// pass=true, 80% ATS, check-gate PASS — but the must-haves are "Extensive expertise in
// Oracle Engineered Systems and subsystems" and "Oracle Database technology including RAC,
// Dataguard, ASM, RMAN", with "cloud platforms (OCI, AWS, Azure, GCP)" explicitly demoted
// to "is a plus". That is an Exadata/DBA seat wearing an SRE title: cv.md greps ZERO for
// exadata, dataguard, rman and oracle rac. Same shape as JPMorgan's "Infrastructure
// Engineer III" (4453410206 / 4473958524), whose body asks for "deep hands-on expertise"
// across "PostgreSQL, Oracle, Oracle Exadata, CockroachDB ... and enterprise database
// administration practices".
//
// GoldenGate is deliberately NOT in this list. It produced two false positives: XenonStack
// names "Oracle GoldenGate replication" as one incidental component of a Cloudera-on-AWS
// data platform, and the Skandha Media weekday row matched a *sibling listing's* title
// ("Platform Engineer - Oracle Golden Gate [T500-30087] Costco Wholesale") spliced onto the
// end of the JD — the same aggregator JD-splice contamination talent.com shows.
//
// Software-development core (same 2026-10-29 pass). Oracle's "Core Infrastructure Engineer"
// (4482538730) scored 100% ATS on a 3.6K JD with ZERO aws/azure/gcp mentions; its basic
// qualifications are "Strong knowledge of C (System programming) and Multi-threaded
// programming" and "2-5 years experience developing commercial software". Zero-overlap with
// an AWS DevOps profile, exactly the Go Lang rationale. Embitel's two "DevOps Engineer" rows
// list "C++ (Expert)" and "Embedded C" under *Mandatory Skills*.
//
// "Go/Python" spelling, 2026-10-30. The Go Lang rule above only matches the token "golang"/
// "go lang", so Edge In Asia's "Senior Software Engineer Site Reliability Engineering (Linux)"
// (301026027403) sat at pass=true, 89% ATS, check-gate PASS — while its JD states the search
// priority outright: "strong Go/Python development skills ... as the primary search priority",
// "Skills: Go/Python, Linux Internals ...", and the eligibility line is "4-8 years of software
// development and SRE experience, writing production-grade services, tools, and automation in
// Go and/or Python". cv.md greps ZERO for both go and python, so this is the Go Lang case in a
// different spelling. Matched on the slashed/"and-or" forms ONLY — a bare "Go" token would hit
// every "go-live"/"ongoing" in the corpus. Measured across all data/*-scan.json: 1 flip, this
// req. The generic "N years of software development experience" phrasing was TESTED AND
// REJECTED as a sibling pattern — it reads as a wrong-core signal on genuine SRE seats that
// merely quantify coding experience.
//
// "Company-hosted data centers" added the same day. The data-centre rule required
// `data cent(er|re) + (infrastructure|environment|operations)`, so Aptonet
// talent-643462145530134685 "Site Reliability Engineer" passed at 87% ATS while its body is an
// on-prem platform-admin seat: "production services deployed primarily in company-hosted data
// centers", stack OpenShift / Ansible Automation Platform / Python / Nexus / Vault, work tracked
// "through ServiceNow and Azure DevOps", and AWS appears exactly once. Measured: 0 flips across
// 2712 passing rows.
//
// ALSO TESTED AND REJECTED, do not retry: `python\s+or\s+go` / `go\s+or\s+python`. It flipped
// 23 rows — "Python or Go" is a routine ONE-OF scripting line in genuine SRE JDs (MoEngage,
// Phenom, Docusign, Teradata x3, Guidewire x3, Okta, Alter Domus, SHL). Same regression class as
// the AGGREGATOR_RAIL revert in [[gate-or-more-floors]]. The consequence is that a real
// backend-dev seat phrased that way (SAP talent-627320545728207341, "4 to 8 years ... proficiency
// in Python or Go for building scalable backend services and microservices") still clears the
// gate and must be held at BORDERLINE by hand, with the reason in its insight.
// One of the 3 initial flips was a SELF-RETRIGGER: the Jobgether DevRel row (lever-jobgether-
// 200d566c) had no go/python anywhere in its JD — the token came from an .insight *we* wrote
// in a prior pass ("wanting Go/Python/Node service-building"). .insight must stay in the
// scanned text (most jdlen=0 rows depend on it), so the fix is to keep wrong-core vendor and
// language tokens OUT of insight prose. Re-check flip counts after any insight rewrite.
const WRONG_CORE_TERMS = /vmware|vsphere|hyper-v\b|data\s*cent(?:er|re)\s+(?:infrastructure|environment|operations)|mainframe|\bcobol\b|windows\s+server\s+administration|\bgo\s*lang\b|\bgolang\b|oracle\s+engineered\s+system|\bexadata\b|\bdata\s*guard\b|oracle\s+rac\b|\brman\b|\bc\+\+\b|\(\s*system\s+programming\s*\)|multi-?threaded\s+programming|developing\s+commercial\s+software|embedded\s+c\b|\bgo\s*\/\s*python\b|\bgo\s+and\/or\s+python\b|(?:company|customer|on-?prem(?:ises)?)[\s-]*hosted\s+data\s*cent(?:er|re)s?/gi;
const HEDGE_NEARBY = /familiar(?:ity)?\s+with|knowledge\s+of|exposure\s+to|nice[\s-]to[\s-]have|good[\s-]to[\s-]have|is\s+a\s+plus\b|\bbonus\b|\boptional\b|preferred\b|desirable\b/i;
// A QUALIFIED "knowledge of" is a must-have, not a hedge (2026-10-29). Bare "knowledge of X"
// earned its place in HEDGE_NEARBY from the 150-job re-audit, but "Strong knowledge of C
// (System programming)" is the hardest requirement in Oracle 4482538730's JD — and the bare
// pattern silently cancelled it, because the hedge test only needs a hit anywhere in the
// 150-char window. Neutralize the qualified form before testing. Measured across all 7 scan
// files: this flips exactly ONE admitted row, that true positive, and zero others.
const MUSTHAVE_KNOWLEDGE =
  /\b(?:strong|solid|deep|in-?depth|expert|extensive|thorough|excellent|proven|advanced|sound|hands-?on)\s+(?:(?:and|or)\s+\w+\s+)?knowledge\s+of\b/gi;
const HEDGE_WINDOW = 150; // chars of context before the match to check for hedging language
// Career-ladder boilerplate is not THIS seat's stack (2026-10-29). Comscore's "Senior DevOps
// Engineer" (comscore.wd5/External REQ1756, an in-band 1-3 yr req) was rejected three times
// over — once per scan file — because its generic job-family blurb says "More senior roles
// act as liaisons between application teams and other operations teams, such as data center
// operations, infrastructure teams and sgl dba teams". That sentence describes roles ABOVE
// this one; "data center operations" is never a requirement here. Treated as a hedge rather
// than an early pass, so scanning CONTINUES — a JD that also names a real wrong-core
// must-have elsewhere still rejects (Apple's apna row keeps rejecting on an unhedged
// "Golang" further down its JD).
const LADDER_BOILERPLATE =
  /\b(?:more\s+senior|higher[\s-]level|senior|principal|staff|lead)\s+(?:roles?|levels?|positions?|engineers?)\b[^.!?]{0,200}$/i;
const VM_FAMILY = /vmware|vsphere|esxi|vcenter|nutanix/gi;
const CLOUD_TOKEN = /\baws\b|\bazure\b|\bgcp\b|google\s+cloud|amazon\s+web\s+services/gi;
// `core` is the title+skills+jd WITHOUT `insight`. The occurrence count has to be taken over
// the JD alone: isWrongCore scans `insight` too, so this pass's own note explaining the
// exemption ("...the VMware mention is incidental") becomes a SECOND vmware hit and silently
// re-rejects the row on the next run — the same self-retrigger that the quoted-term guard
// above was added for. Counting over `core` makes the rule independent of our own prose.
function isIncidentalCloudPeer(text, m, core) {
  if (!/vmware|vsphere/i.test(m[0])) return false;
  if ((core.match(VM_FAMILY) || []).length !== 1) return false;
  if ((core.match(CLOUD_TOKEN) || []).length < 3) return false;
  // must sit inside a comma/slash run, not stand alone in its own clause
  if (!/[,/]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index))) return false;
  if (!/^\s*[,/]/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 3))) return false;
  const window = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
  return new Set((window.match(CLOUD_TOKEN) || []).map((x) => x.toLowerCase())).size >= 2;
}
export function isWrongCore(job) {
  const core = `${job.title || job.role || ""} ${[job.skills].flat().filter(Boolean).join(" ")} ${job.jd || ""}`;
  const text = `${core} ${job.insight || ""}`;
  WRONG_CORE_TERMS.lastIndex = 0;
  let m;
  while ((m = WRONG_CORE_TERMS.exec(text))) {
    const before = text
      .slice(Math.max(0, m.index - HEDGE_WINDOW), m.index)
      .replace(MUSTHAVE_KNOWLEDGE, " ");
    if (HEDGE_NEARBY.test(before)) continue;
    // A QUOTED term is being cited, not required (2026-10-29). Because isWrongCore also scans
    // `insight`, a prior pass's own note explaining a false positive re-triggered it: the
    // Comscore rows carry "...the known ladder-boilerplate false positive ('data center
    // operations' in a more-senior-roles sentence)", and the quoted phrase fired the gate a
    // second time, outside the ladder sentence. Measured across all 7 scan files: 4 quoted
    // occurrences total, every one a prior annotation (Comscore x2, Kyndryl 'mainframe',
    // Barclays 'Golang'), zero real JD requirements.
    if (/['"“‘]/.test(text[m.index - 1] || "") && /['"”’]/.test(text[m.index + m[0].length] || "")) continue;
    // sentence the match sits in — ladder blurbs describe roles above this one
    const sentence = text.slice(Math.max(0, m.index - 400), m.index).split(/[.!?]\s/).pop();
    if (LADDER_BOILERPLATE.test(sentence)) continue;
    // Employer marketing copy names vendors the COMPANY works with, not the seat's stack
    // (2026-10-29). CyFuture's "DevOps Engineer" (3-4 yrs, talent.com) rejected on two
    // VMware mentions, both in its About section: "cloud infrastructure ... across platforms
    // like AWS, Azure, and VMware" and "strategic partnerships with global OEMs such as
    // VMware, AWS, Azure, HP, Dell". Deliberately narrow to partnership/platform-portfolio
    // phrasing: a broader employer-profile regex (partnership|clientele|about us|OEM|leading
    // provider) wrongly exempted MSD's genuine "Senior Data Center Engineer" req and NTT
    // DATA's entry-level "Windows Server Administration" seat. This version flips exactly
    // one row across all 7 scan files — the CyFuture false positive.
    if (/(?:strategic\s+)?partnerships\s+with|across\s+platforms\s+like|our\s+clientele/i.test(
      text.slice(Math.max(0, m.index - 200), m.index))) continue;
    // An INCIDENTAL mention inside a cloud-peer enumeration (2026-10-30). NCR Voyix's
    // "Site Reliability Engineer I" (devops 4484956365 / 4484450760, naukri 291026501654 —
    // one req, live on ncr.wd1/ext_apac, posted 2026-10-29, floor "1-2 years") rejected on a
    // single "VMware" sitting in a patching-scope list: "server patching across Azure, GCP,
    // AWS, VMware, Windows, and Linux environments". VMware there is one patch target among
    // three real clouds, not the seat's core — the JD names AWS 3x and is otherwise Dynatrace/
    // Datadog/Splunk/ServiceNow SRE work at an in-band grade.
    // Deliberately narrow, and it has to be: the obvious version of this rule (exempt any
    // wrong-core term with a cloud name adjacent) flipped 18 rows, of which only this req was
    // a real false positive. The rest are GENUINE VMware seats that must keep rejecting —
    // Blue Yonder's "2+ years' experience with VMWare, Azure, AWX" (aws=0), Credera's "Strong
    // experience with VMware and Microsoft Azure infrastructure", ADB SAFEGATE/Staffington's
    // "Azure VMware Solution" operations, 11:11 Systems' skills list of literally "VMware,
    // OpenStack, AWS", Trintech's VMware-as-core-skill, Avihs' 5 vSphere/ESXi mentions.
    // So all three conditions are required: the vmware family appears EXACTLY ONCE in the
    // whole text (a real VMware seat always names it more than once), >=3 major-cloud tokens
    // appear elsewhere, and the match sits inside a comma run naming >=2 distinct clouds.
    // Measured across all 7 scan files: 4 rows flip — the 3 NCR rows plus one GCC India
    // "Platform Engineer II (Azure)" row that stays red anyway at 45% ATS. Zero admits.
    if (isIncidentalCloudPeer(text, m, core)) continue;
    return true; // an unhedged, non-boilerplate mention = a real wrong-core signal
  }
  return false;
}

// Enterprise-platform seats hiding under a DevOps/SRE/Platform title (2026-10-14 lesson).
// A title like "Salesforce DevOps Engineer–Copado", "SAP BTP/ML Devops", "DevOps MuleSoft
// Engineer" or "Power Platform Engineer" scores 78-92% on ats-check because the JD is full
// of generic CI/CD, pipeline, release and automation vocabulary — but the actual product
// being operated is one cv.md greps ZERO times (salesforce, copado, servicenow, sap,
// mulesoft, apigee, informatica, pega, power platform: 0 hits each). Found 19 such rows
// sitting at pass=true, clustered at the TOP of the green list exactly like the dead reqs
// in the 10-14d liveness audit.
//
// Deliberately TITLE-ONLY, unlike isWrongCore's hedge-aware body scan. The 2026-07-29
// re-audit lesson was that blind body substring matching killed 52 genuinely strong AWS
// matches; these terms are far worse in a body scan than VMware ever was, because real
// AWS DevOps JDs legitimately name ServiceNow as the change-management tool, Apigee as an
// API gateway and SAP as a workload being hosted. In a TITLE the platform is never
// incidental — it IS the seat. Validated on 62 matching rows across all 7 scan files:
// every one was a genuine platform-specialist posting, zero false positives.
//
// EUC / endpoint-management extension (2026-10-14f). Same shape, different product family:
// "Senior EUC Platform Engineer [T500-30081]" and "Lead EUC Platform Engineer [T500-28380]"
// (both Talent500, hiring for Zurich) each scored 91% on ats-check and check-gate PRINTED
// PASS on both — one was sitting at pass=true with a tailored PDF already built. The JD is
// End User Computing: Microsoft Intune, Entra ID, Windows 365, AVD/VDI, Windows 10/11
// Autopilot provisioning, MSI/EXE/MSIX software packaging with PSAppDeploy Toolkit. The 91%
// came from keyword overlap on Azure/AWS/PowerShell/automation/patching, not from the seat.
// cv.md greps ZERO for: euc, end user computing, intune, citrix, vdi, virtual desktop,
// windows 365, sccm, mecm, autopilot, msix, jamf, workspace one, mdm, entra, group policy,
// active directory, packaging, guidewire.
// Scoped deliberately: "windows autopilot" not bare "autopilot" (a bare match would hit
// Tesla-style "Autopilot" product teams), and "application/software packaging" not bare
// "packaging". Dry-ran over all 7 scan files: 4 titles matched, every one a genuine
// EUC/desktop/MDM/Guidewire seat, zero false positives, 1 bad green flipped.
const WRONG_PLATFORM_TITLE =
  /salesforce|\bsfdc\b|copado|visualforce|servicenow|\bsap\b|\babap\b|mulesoft|\bapigee\b|webmethods|\bapama\b|\btibco\b|informatica|datastage|ab\s*initio|power\s*platform|powerapps|power\s*apps|dynamics\s*365|peoplesoft|oracle\s+fusion|\bsiebel\b|\bpega\b|\bveeva\b|\bworkday\b|sharepoint|\beuc\b|end[\s-]user\s*computing|intune|\bcitrix\b|\bvdi\b|virtual\s*desktop\b|windows\s*365|\bsccm\b|\bmecm\b|windows\s*autopilot|\bmsix\b|\bjamf\b|workspace\s*one\b|\bmdm\b|\bdesktop\b|(?:application|software)\s*packaging|endpoint\s*(?:management|engineer)|guidewire|nexthink|\baternity\b|digital\s*employee\s*experience/i;
export function isWrongPlatformTitle(job) {
  return WRONG_PLATFORM_TITLE.test(String(job.title || job.role || ""));
}

// Enterprise-platform must-have declared in PROSE, under a generic title (2026-10-14i).
// The 10-14g GCP rule only reads the structured "Must have skills :" field, and
// isWrongPlatformTitle only reads the title — so the Accenture JD template's OTHER
// phrasing slipped through both: a bare "DevOps Engineer" title whose single hard
// requirement is a sentence, "The candidate should have minimum 3 years of experience
// in ServiceNow", sitting right beside the "15 years full time education" line. These
// score 88-100% on ats-check purely on the surrounding generic CI/CD, pipeline,
// container-orchestration and security vocabulary (ats=100 is the known coverage-%
// pitfall, not a real fit) while the seat is a ServiceNow ITSM/ITOM/HRSD/SAM,
// Salesforce DevOps or SAP ABAP specialist post. cv.md greps ZERO for all of them.
//
// Scoped to UNHEDGED REQUIREMENT CLAUSES, never a blind body scan — this is the whole
// reason it is safe where the 2026-07-29 blind-substring attempt killed 52 good matches.
// Only two lead-ins count, both of which declare a requirement by construction:
// "minimum/at least N years of experience in <X>" and "<X> as a must-have skill".
// A platform named anywhere else — ServiceNow as the change-management tool, SharePoint
// as a docs store — cannot reach these captures.
//
// The term list is also deliberately NARROWER than WRONG_PLATFORM_TITLE: bare "sap"
// (kept only as \babap\b), apigee, tibco, workday, mdm, desktop, endpoint management
// and digital-employee-experience are all DROPPED here, because unlike in a title they
// are plausibly incidental even inside a requirement clause ("experience in SAP
// workloads on AWS", and "Workday" is both a product and an ATS vendor name).
// Validated across all 5104 rows in all 7 scan files: 53 matched, every one a genuine
// platform-module must-have on eyeball, zero false positives, 6 bad greens flipped.
const WRONG_PLATFORM_MUSTHAVE =
  /salesforce|\bsfdc\b|copado|visualforce|servicenow|\babap\b|mulesoft|webmethods|\bapama\b|informatica|datastage|ab\s*initio|power\s*platform|powerapps|dynamics\s*365|peoplesoft|oracle\s+fusion|\bsiebel\b|\bpega\b|\bveeva\b|sharepoint|\beuc\b|end[\s-]user\s*computing|intune|\bcitrix\b|\bvdi\b|virtual\s*desktop\b|windows\s*365|\bsccm\b|\bmecm\b|\bmsix\b|\bjamf\b|workspace\s*one\b|(?:application|software)\s*packaging|guidewire|nexthink|\baternity\b/i;
const REQUIREMENT_CLAUSES = [
  /(?:minimum|at\s+least)\s+\d+\+?\s*years?\s+of\s+experience\s+in\s+([^.\n\u2022|]{0,140})/gi,
  // Post-modified requirement clause (2026-10-30): "7+ years of ServiceNow Platform experience".
  // Mondelez talent-626348144839098896 is titled "Platform Engineer" (so isWrongPlatformTitle is
  // clean) and names ServiceNow 13 times, yet passed the gate at 100% ATS because neither clause
  // above reads a platform named BEFORE the word "experience". Its exp floor cannot be relied on
  // here either — "Bachelor's degree preferred" sits in the hedge window and cancels the 7+.
  // Measured: 0 flips across 2712 passing rows, so this costs nothing and closes one more
  // instance of [[gate-blindspot-platform-title-wrong-discipline]].
  /\d+\+?\s*years?\s+of\s+([^.\n\u2022|]{0,60}?)\s+experience\b/gi,
  /([^.\n\u2022|]{0,140}?)\s+as\s+a\s+must[\s-]have\s+skill/gi,
];
export function wrongPlatformMustHave(job) {
  const jd = String(job.jd || "");
  if (!jd) return "";
  for (const re of REQUIREMENT_CLAUSES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(jd))) {
      const span = m[1] || "";
      if (WRONG_PLATFORM_MUSTHAVE.test(span)) return span.trim().slice(0, 110);
    }
  }
  return "";
}
export function isWrongPlatformMustHave(job) {
  return wrongPlatformMustHave(job) !== "";
}

// Training academies / placement institutes posting "jobs" that are course lead-gen
// (iTester Academy lesson, 2026-07-27). Judged on the EMPLOYER name only.
const SUSPECT_EMPLOYER = /academy|institute\b|\btrainings?\b|placement|coaching/i;
export function isSuspectEmployer(job) {
  return SUSPECT_EMPLOYER.test(String(job.company || ""));
}

// Support-titled roles (per Nikhil 2026-07-27): rotational/night shifts are FINE —
// the decision is his stack vs the JD's stack, nothing else. A support-titled role is
// rejected ONLY when its text shows none of his core stack (EY case: Splunk/Harness/
// Windows helpdesk → out). A support-titled role that runs on AWS + K8s/Terraform/
// Jenkins/Docker is a real ops-engineering seat and stays in (Accenture case).
const SUPPORT_TITLE = /\bsupport\b|help\s*desk|\bl[12]\b|service\s*desk|\bnoc\b/i;
const CORE_STACK = /\baws\b|amazon web services|kubernetes|\bk8s\b|\beks\b|terraform|jenkins|docker|argo\s*cd|prometheus/i;

// Does the job's TEXT (skills/jd/insight — never the title) show Nikhil's core stack?
// This is the universal principle (per Nikhil 2026-07-27): the title can be ANYTHING;
// fit is judged by comparing the JD's stack to his résumé.
export function hasCoreStack(job) {
  const text = `${[job.skills].flat().filter(Boolean).join(" ")} ${job.jd || ""} ${job.insight || ""}`;
  return CORE_STACK.test(text);
}

export function isSupportRole(job) {
  if (!SUPPORT_TITLE.test(String(job.title || job.role || ""))) return false;
  return !hasCoreStack(job); // support title + none of his stack → out; stack present → in
}

// L2/L3 application-support core hiding under an engineering title (2026-10-30). isSupportRole
// above is TITLE-only, so a seat whose *body* is production/application support sails through
// whenever its title is clean. Creyente Infotech's "Application & AWS Platform Engineer"
// (4477375488) sat at pass=true, 100% ATS, check-gate PASS — but its Mandatory block reads
// "Production and application support", "Linux troubleshooting", "basic Python knowledge",
// "Basic knowledge of CI/CD concepts", and the duties are "Handle L2/L3 escalations", "support
// application deployments, batch processing, and scheduled jobs", "Participate in rotational
// weekend and critical production support". No Kubernetes, no Terraform, no pipeline ownership
// anywhere: that is an app-support seat, and the 100% ATS is the skill-sparse-JD artifact.
//
// Deliberately requires FIVE distinct support signals, not two. At >=2 this flipped 22 rows,
// nearly all genuine SRE seats that merely *mention* production support or RCA among real
// build duties (Schwab, DBS, CIBC, Jefferies). At >=4 it still caught CIBC's "Analyst, Site
// Reliability Engineering" (4480955878) — an in-band junior SRE req whose signals come from
// employer boilerplate, not duties. At >=5: 1 flip, the Creyente req. Do not loosen this.
const APP_SUPPORT_SIGNALS = [
  /\bL2\s*\/\s*L3\b/i,
  /\bL[23]\s+escalations?\b/i,
  /production\s+and\s+application\s+support/i,
  /application\s+support\b/i,
  /production\s+support\b/i,
  /incident\s+resolution\b/i,
  /root\s+cause\s+analysis\b/i,
];

export function isAppSupportCore(job) {
  const jd = String(job.jd || "");
  if (!jd) return false; // title-only rows are isSupportRole's business, not this rule's
  return APP_SUPPORT_SIGNALS.filter((re) => re.test(jd)).length >= 5;
}

// Combined gate used by every sheet builder AND mirrored by the /jd command —
// the sheet's "apply" and /jd's verdict must always agree.
export function sheetAdmits(job, maxYears = 4) {
  return !tooSenior(job, maxYears) && !isAzureJob(job) && !isGcpJob(job)
    && !isWrongCore(job) && !isWrongPlatformTitle(job) && !isWrongPlatformMustHave(job)
    && !isSuspectEmployer(job)
    && !isSupportRole(job) && !isAppSupportCore(job) && !isOutOfBandGrade(job);
}

// Normalized company+title key for same-day duplicate collapse: portals list the
// same opening under company-name variants ("Accenture in India" / "Accenture
// services Pvt Ltd") with distinct job ids. Strip legal/location suffixes so those
// variants collapse to one row.
const COMPANY_NOISE =
  /\b(?:in india|india|pvt\.?|private|ltd\.?|limited|inc\.?|llc|llp|corp\.?|corporation|technologies|technology|solutions|services|systems|software|group|global)\b/g;
export function dupKey(job) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  let company = norm(job.company).replace(COMPANY_NOISE, "").replace(/\s+/g, " ").trim();
  if (!company) company = norm(job.company); // suffix-only names ("Global Solutions") keep their raw form
  return `${company}|${norm(job.title || job.role)}`;
}
