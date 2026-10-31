// The campaign: chapters of stages, each stage three puzzles for the team to
// solve. Shared by the server (which generates and checks the puzzles) and the
// browser (which draws the stage map). Nothing in this file is secret: it says
// which kinds of puzzle a stage has and how hard they are, never their content.
//
// Stage format, version 1:
//   { format, id: '3-14', index, chapter, number, title, beat,
//     puzzles: [{ type, level }, x3], parMs, limitMs, difficulty: 1-5, finale }
//
// To add a chapter: add its story to shared/story.js and a plan below, choosing
// which mechanics appear and at which levels. Stage composition is derived
// deterministically from the plan, so ids and contents never shift unless the
// plan changes; bump CAMPAIGN_VERSION if they do. To add a mechanic: add it to
// MECHANICS, write server/puzzles/<type>.js with the same number of levels, and
// a renderer for each role in the browser.

import { CHAPTER_STORY } from './story.js';

export const STAGE_FORMAT = 1;
export const CAMPAIGN_VERSION = 1;
export const STAGES_PER_CHAPTER = 20;
export const PUZZLES_PER_STAGE = 3;

export const MECHANICS = Object.freeze({
  'dead-line': { title: 'The Dead Line', skill: 'Symbol decoding', maxLevel: 10, parBase: 100, parStep: 18 },
  'patch-bay': { title: 'The Patch Bay', skill: 'Routing', maxLevel: 10, parBase: 120, parStep: 20 },
  teleprinter: { title: 'The Teleprinter', skill: 'Punched tape', maxLevel: 10, parBase: 130, parStep: 20 },
  'party-line': { title: 'The Party Line', skill: 'Ring patterns', maxLevel: 8, parBase: 110, parStep: 22 },
  'relay-rack': { title: 'The Relay Rack', skill: 'Sequence deduction', maxLevel: 8, parBase: 120, parStep: 22 },
  'cipher-wheel': { title: 'The Cipher Wheel', skill: 'Telegram cipher', maxLevel: 8, parBase: 110, parStep: 22 },
});

export const puzzleParMs = (type, level) => (MECHANICS[type].parBase + MECHANICS[type].parStep * (level - 1)) * 1000;

/** Countdown for a stage in a timed game: generous, so stars, not the clock, reward speed. */
export const stageLimitMs = (parMs) => Math.max(6 * 60_000, Math.round((parMs * 2) / 30_000) * 30_000);

/**
 * Authored plan for each chapter: the mechanics in play, the level range for
 * each, and the chapter's featured mechanic (it appears in two of every three
 * stages and headlines the finale).
 */
const PLANS = [
  { featured: 'dead-line', pool: { 'dead-line': [1, 4], 'patch-bay': [1, 3], teleprinter: [1, 3] } },
  { featured: 'party-line', pool: { 'party-line': [1, 3], 'dead-line': [3, 5], 'patch-bay': [2, 4], teleprinter: [2, 4] } },
  { featured: 'patch-bay', pool: { 'patch-bay': [3, 5], 'dead-line': [4, 5], 'party-line': [2, 4], teleprinter: [3, 4] } },
  { featured: 'cipher-wheel', pool: { 'cipher-wheel': [1, 4], teleprinter: [4, 6], 'party-line': [3, 5], 'dead-line': [5, 7] } },
  { featured: 'relay-rack', pool: { 'relay-rack': [1, 4], 'dead-line': [6, 7], 'patch-bay': [5, 7], 'cipher-wheel': [3, 5] } },
  { featured: 'dead-line', pool: { 'dead-line': [6, 8], 'party-line': [5, 6], 'cipher-wheel': [4, 6], 'relay-rack': [3, 5] } },
  { featured: 'patch-bay', pool: { 'patch-bay': [6, 8], teleprinter: [6, 8], 'relay-rack': [4, 6], 'cipher-wheel': [5, 6] } },
  { featured: 'party-line', pool: { 'party-line': [6, 8], 'cipher-wheel': [6, 7], 'dead-line': [7, 9], teleprinter: [7, 8] } },
  { featured: 'relay-rack', pool: { 'relay-rack': [6, 8], 'patch-bay': [7, 9], teleprinter: [8, 9], 'cipher-wheel': [6, 8] } },
  {
    featured: 'teleprinter',
    pool: { teleprinter: [9, 10], 'dead-line': [8, 10], 'patch-bay': [8, 10], 'party-line': [7, 8], 'relay-rack': [7, 8], 'cipher-wheel': [7, 8] },
  },
];

export const CHAPTERS = Object.freeze(
  PLANS.map((plan, i) => {
    const story = CHAPTER_STORY[i];
    return Object.freeze({
      format: STAGE_FORMAT,
      id: `ch${i + 1}`,
      number: i + 1,
      title: story.title,
      blurb: story.blurb,
      intro: story.intro,
      outro: story.outro,
      featured: plan.featured,
      pool: plan.pool,
    });
  }),
);

const range = ([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const signature = (puzzles) =>
  puzzles
    .map((p) => `${p.type}:${p.level}`)
    .sort()
    .join('|');

/** Every distinct three-mechanic combination a chapter's plan allows. */
function candidatesFor(plan) {
  const types = Object.keys(plan.pool);
  const out = [];
  for (let a = 0; a < types.length; a++) {
    for (let b = a + 1; b < types.length; b++) {
      for (let c = b + 1; c < types.length; c++) {
        const trio = [types[a], types[b], types[c]];
        for (const la of range(plan.pool[trio[0]])) {
          for (const lb of range(plan.pool[trio[1]])) {
            for (const lc of range(plan.pool[trio[2]])) {
              const puzzles = [
                { type: trio[0], level: la },
                { type: trio[1], level: lb },
                { type: trio[2], level: lc },
              ];
              // Easiest puzzle first, so each stage warms up.
              puzzles.sort((x, y) => puzzleParMs(x.type, x.level) - puzzleParMs(y.type, y.level) || x.type.localeCompare(y.type));
              out.push({
                puzzles,
                par: puzzles.reduce((sum, p) => sum + puzzleParMs(p.type, p.level), 0),
                key: signature(puzzles),
                types: trio.join('|'),
                featured: trio.includes(plan.featured),
              });
            }
          }
        }
      }
    }
  }
  return out.sort((x, y) => x.par - y.par || x.key.localeCompare(y.key));
}

/**
 * Picks twenty distinct stages along a rising difficulty curve: each stage's
 * total par time tracks a target that climbs from the chapter's easiest
 * combination to its hardest, never repeats a combination used anywhere in the
 * campaign, avoids repeating the previous stage's mix, and features the
 * chapter's mechanic in two of every three stages and in the finale.
 */
function composeChapter(plan, used) {
  const candidates = candidatesFor(plan).filter((c) => !used.has(c.key));
  const featured = candidates.filter((c) => c.featured);
  // The finale is the hardest featured combination; reserve it first.
  const finale = featured.reduce((a, b) => (b.par > a.par || (b.par === a.par && b.key < a.key) ? b : a));
  used.add(finale.key);
  const minPar = candidates[0].par;
  const maxPar = Math.max(...featured.filter((c) => c !== finale).map((c) => c.par));
  const picked = [];
  let prev = null;
  const regular = STAGES_PER_CHAPTER - 1;
  for (let k = 0; k < regular; k++) {
    const target = minPar + ((maxPar - minPar) * k) / (regular - 1);
    const needsFeatured = k % 3 !== 2;
    let best = null;
    let bestCost = Infinity;
    for (const c of candidates) {
      if (used.has(c.key)) continue;
      let cost = Math.abs(c.par - target) / 1000;
      if (needsFeatured && !c.featured) cost += 500;
      if (prev && c.par < prev.par) cost += 60;
      if (prev && c.types === prev.types && candidates.length > 60) cost += 25;
      if (cost < bestCost || (cost === bestCost && c.key < best.key)) {
        best = c;
        bestCost = cost;
      }
    }
    if (!best) throw new Error(`Chapter plan has too few distinct stages (stopped at ${k + 1})`);
    used.add(best.key);
    picked.push(best);
    prev = best;
  }
  picked.push(finale);
  return picked;
}

function difficultyOf(puzzles) {
  const avg = puzzles.reduce((sum, p) => sum + p.level / MECHANICS[p.type].maxLevel, 0) / puzzles.length;
  return Math.min(5, Math.max(1, Math.ceil(avg * 5)));
}

function buildStages() {
  const used = new Set();
  const stages = [];
  CHAPTERS.forEach((chapter, ci) => {
    const story = CHAPTER_STORY[ci];
    composeChapter(PLANS[ci], used).forEach((c, k) => {
      const [title, beat] = story.stages[k];
      stages.push(
        Object.freeze({
          format: STAGE_FORMAT,
          id: `${chapter.number}-${k + 1}`,
          index: stages.length,
          chapter: chapter.number,
          number: k + 1,
          title,
          beat,
          puzzles: Object.freeze(c.puzzles.map((p) => Object.freeze({ ...p }))),
          parMs: c.par,
          limitMs: stageLimitMs(c.par),
          difficulty: difficultyOf(c.puzzles),
          finale: k === STAGES_PER_CHAPTER - 1,
        }),
      );
    });
  });
  return Object.freeze(stages);
}

export const STAGES = buildStages();
const BY_ID = new Map(STAGES.map((s) => [s.id, s]));

export const stageById = (id) => (typeof id === 'string' ? BY_ID.get(id) || null : null);
export const chapterOf = (stage) => CHAPTERS[stage.chapter - 1];
export const nextStage = (stage) => STAGES[stage.index + 1] || null;
export const isFinalStage = (stage) => stage.index === STAGES.length - 1;
export const stageSignature = (stage) => signature(stage.puzzles);

/** Checks the campaign's structure. Returns a list of problems (empty when valid). */
export function validateCampaign(stages = STAGES, chapters = CHAPTERS) {
  const problems = [];
  const ids = new Set();
  const signatures = new Set();
  for (const s of stages) {
    if (s.format !== STAGE_FORMAT) problems.push(`${s.id}: unknown stage format ${s.format}`);
    if (ids.has(s.id)) problems.push(`${s.id}: duplicate id`);
    ids.add(s.id);
    if (!s.title || !s.beat) problems.push(`${s.id}: missing title or story beat`);
    if (s.puzzles.length !== PUZZLES_PER_STAGE) problems.push(`${s.id}: needs ${PUZZLES_PER_STAGE} puzzles`);
    if (new Set(s.puzzles.map((p) => p.type)).size !== s.puzzles.length) problems.push(`${s.id}: repeats a mechanic`);
    for (const p of s.puzzles) {
      const m = MECHANICS[p.type];
      if (!m) problems.push(`${s.id}: unknown mechanic ${p.type}`);
      else if (!Number.isInteger(p.level) || p.level < 1 || p.level > m.maxLevel) problems.push(`${s.id}: bad level for ${p.type}`);
    }
    const sig = signature(s.puzzles);
    if (signatures.has(sig)) problems.push(`${s.id}: same puzzle mix as an earlier stage`);
    signatures.add(sig);
  }
  if (new Set(stages.map((s) => s.title)).size !== stages.length) problems.push('stage titles are not unique');
  if (new Set(stages.map((s) => s.beat)).size !== stages.length) problems.push('stage story beats are not unique');
  for (const ch of chapters) {
    if (ch.format !== STAGE_FORMAT) problems.push(`${ch.id}: unknown chapter format`);
    if (!MECHANICS[ch.featured] || !ch.pool[ch.featured]) problems.push(`${ch.id}: featured mechanic missing from its pool`);
  }
  return problems;
}
