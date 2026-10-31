import { CAMPAIGN_VERSION, STAGES, stageById } from '../shared/campaign.js';

/**
 * A team's campaign progress: the best stars and score for each completed
 * stage. Stage n is playable once stage n-1 is complete. Progress belongs to
 * the room while you play and is also handed to both browsers, signed, so it
 * survives a server restart and carries over to the next room you open.
 */
export class Progress {
  constructor() {
    this.stages = new Map(); // stageId -> { stars, best }
  }

  get(stageId) {
    return this.stages.get(stageId) || null;
  }

  completed(stageId) {
    return this.stages.has(stageId);
  }

  isUnlocked(stageId) {
    const stage = stageById(stageId);
    if (!stage) return false;
    return stage.index === 0 || this.completed(STAGES[stage.index - 1].id);
  }

  /** The first stage not yet completed whose predecessor is (or the last stage). */
  frontier() {
    for (const stage of STAGES) if (!this.completed(stage.id)) return stage;
    return STAGES[STAGES.length - 1];
  }

  /** Records a finished stage and reports whether it beat the old best. */
  record(stageId, { score, stars }) {
    const old = this.get(stageId);
    const firstClear = !old;
    const isBest = !old || score > old.best;
    this.stages.set(stageId, { stars: Math.max(stars, old?.stars || 0), best: Math.max(score, old?.best || 0) });
    return { firstClear, isBest, previousBest: old?.best ?? null };
  }

  /** Keeps the better of each stage. Returns true if anything changed. */
  merge(other) {
    let changed = false;
    for (const [id, entry] of other.stages) {
      const mine = this.get(id);
      if (!mine || entry.stars > mine.stars || entry.best > mine.best) {
        this.stages.set(id, { stars: Math.max(entry.stars, mine?.stars || 0), best: Math.max(entry.best, mine?.best || 0) });
        changed = true;
      }
    }
    return changed;
  }

  totals() {
    let stars = 0;
    for (const e of this.stages.values()) stars += e.stars;
    return { completed: this.stages.size, stars, maxStars: STAGES.length * 3, total: STAGES.length };
  }

  /** What browsers see: per-stage results plus totals. */
  view() {
    return { version: CAMPAIGN_VERSION, stages: Object.fromEntries(this.stages), frontier: this.frontier().id, ...this.totals() };
  }

  toJSON() {
    return { v: CAMPAIGN_VERSION, s: Object.fromEntries([...this.stages].map(([id, e]) => [id, [e.stars, e.best]])) };
  }

  /** Builds progress from stored or client-supplied data, dropping anything unknown or malformed. */
  static from(data) {
    const progress = new Progress();
    if (!data || typeof data !== 'object' || typeof data.s !== 'object' || !data.s) return progress;
    for (const [id, entry] of Object.entries(data.s)) {
      if (!stageById(id) || !Array.isArray(entry)) continue;
      const [stars, best] = entry;
      if (![1, 2, 3].includes(stars) || !Number.isInteger(best) || best < 0 || best > 1000) continue;
      progress.stages.set(id, { stars, best });
    }
    return progress;
  }
}
