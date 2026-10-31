import { MECHANICS, isFinalStage, stageById } from '../shared/campaign.js';
import { scoreStage } from '../shared/scoring.js';
import { PUZZLES } from './puzzles/index.js';
import { cryptoRng, newId } from './random.js';

export const WRONG_PENALTY_MS = 30_000;
export const ANSWER_COOLDOWN_MS = 2_500;
export const HINT_COOLDOWN_MS = 30_000;
export const HINTS_PER_ROLE = 3;
/** Partial-match feedback ("2 of 4 relays held") starts on this attempt. */
export const FEEDBACK_FROM_ATTEMPT = 2;
/** After each solved puzzle the stage clock waits this long, so the change-over never counts. */
export const TRANSITION_MS = 4_000;

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const PHASES = ['lobby', 'playing', 'complete', 'failed', 'finale'];

/**
 * One room's play: the stage map (lobby), a stage run of three puzzles, and the
 * result screen afterwards. Holds every secret (answers, both roles' data) and
 * only ever hands out role-filtered views via `viewFor`.
 *
 * The stage clock counts active play only. It stops while either player is
 * disconnected and during the change-over after each solved puzzle, so the
 * score never depends on the network or on how long a client animates.
 */
export class Game {
  constructor({ mode = 'timed', rng = cryptoRng } = {}) {
    this.mode = mode;
    this.rng = rng;
    this.phase = 'lobby';
    this.run = null;
    this.result = null;
    this.lastAnswerAt = -Infinity;
  }

  get timed() {
    return this.mode === 'timed';
  }

  get playing() {
    return this.phase === 'playing';
  }

  get stage() {
    return this.run ? stageById(this.run.stageId) : null;
  }

  get round() {
    return this.run && this.playing ? this.run.rounds[this.run.index] : null;
  }

  get paused() {
    return this.playing && this.run.runningSince == null;
  }

  /** Starts a fresh run of `stage`. `running` is false when a player is missing. */
  startStage(stage, now, { running = true } = {}) {
    if (this.playing) return false;
    const runId = newId(4);
    this.run = {
      id: runId,
      stageId: stage.id,
      index: 0,
      activeMs: 0,
      penaltyMs: 0,
      runningSince: running ? now : null,
      wrong: 0,
      hints: 0,
      rounds: stage.puzzles.map((spec, i) => ({
        id: `${runId}.${i + 1}`,
        type: spec.type,
        level: spec.level,
        state: PUZZLES[spec.type].generate(this.rng, spec.level),
        attempts: 0,
        solved: false,
        hints: { caller: { shown: 0, lastAt: 0 }, operator: { shown: 0, lastAt: 0 } },
      })),
    };
    this.phase = 'playing';
    this.result = null;
    this.lastAnswerAt = -Infinity;
    return true;
  }

  /** Leaves a run or a result for the stage map. */
  toLobby() {
    this.phase = 'lobby';
    this.run = null;
    this.result = null;
  }

  activeMs(now) {
    const run = this.run;
    if (!run) return 0;
    return run.activeMs + (run.runningSince == null ? 0 : Math.max(0, now - run.runningSince));
  }

  limitMs() {
    return this.timed && this.stage ? this.stage.limitMs : null;
  }

  remaining(now) {
    const limit = this.limitMs();
    return limit == null ? null : Math.max(0, limit - this.activeMs(now) - this.run.penaltyMs);
  }

  pause(now) {
    const run = this.run;
    if (!this.playing || run.runningSince == null) return false;
    run.activeMs += Math.max(0, now - run.runningSince);
    run.runningSince = null;
    return true;
  }

  resume(now) {
    if (!this.playing || this.run.runningSince != null) return false;
    this.run.runningSince = now;
    return true;
  }

  /** Ends a timed run whose clock has run out. Returns true if it just ended. */
  checkTimeout(now) {
    if (this.playing && this.timed && this.remaining(now) <= 0) {
      this.pause(now);
      this.phase = 'failed';
      this.result = this.summary(now, { failed: true });
      return true;
    }
    return false;
  }

  summary(now, extra = {}) {
    const run = this.run;
    const stage = this.stage;
    return {
      stageId: run.stageId,
      runId: run.id,
      activeMs: this.activeMs(now),
      parMs: stage.parMs,
      limitMs: this.limitMs(),
      wrong: run.wrong,
      hints: run.hints,
      solved: run.rounds.filter((r) => r.solved).length,
      ...extra,
    };
  }

  submitAnswer(role, puzzleId, raw, now) {
    if (!this.playing) return fail('NOT_PLAYING', 'There is nothing to answer right now.');
    if (role !== 'caller') return fail('NOT_ALLOWED', 'Only the Caller can operate the machines.');
    const round = this.round;
    if (puzzleId !== round.id) return fail('STALE', 'That answer was for a puzzle you have already moved past.');
    if (this.paused) return fail('PAUSED', 'The line is paused until your partner reconnects.');
    const wait = this.lastAnswerAt + ANSWER_COOLDOWN_MS - now;
    if (wait > 0) return fail('COOLDOWN', 'The machine is still resetting. Try again in a moment.', { retryInMs: wait });

    const def = PUZZLES[round.type];
    const parsed = def.parseAnswer(raw, round.state);
    if (parsed.error) return fail('INVALID', parsed.error);

    this.lastAnswerAt = now;
    round.attempts++;
    const result = def.check(round.state, parsed.value);
    const title = MECHANICS[round.type].title;

    if (result.correct) {
      round.solved = true;
      const run = this.run;
      if (run.index === run.rounds.length - 1) {
        this.pause(now);
        const stage = this.stage;
        this.phase = isFinalStage(stage) ? 'finale' : 'complete';
        this.result = { ...this.summary(now), ...scoreStage({ activeMs: run.activeMs, parMs: stage.parMs, wrong: run.wrong, hints: run.hints }) };
        return { ok: true, correct: true, puzzleId, solvedTitle: title, stageComplete: true };
      }
      // Bank the time so far, then hold the clock through the change-over.
      if (run.runningSince != null) {
        run.activeMs += Math.max(0, now - run.runningSince);
        run.runningSince = now + TRANSITION_MS;
      }
      run.index++;
      return { ok: true, correct: true, puzzleId, solvedTitle: title, stageComplete: false };
    }

    this.run.wrong++;
    const penaltyMs = this.timed ? WRONG_PENALTY_MS : 0;
    this.run.penaltyMs += penaltyMs;
    const lost = this.checkTimeout(now);
    const feedback = round.attempts >= FEEDBACK_FROM_ATTEMPT ? { matched: result.matched, total: result.total, unit: result.unit } : null;
    return { ok: true, correct: false, puzzleId, penaltyMs, feedback, attempts: round.attempts, lost };
  }

  requestHint(role, puzzleId, now) {
    if (!this.playing) return fail('NOT_PLAYING', 'Hints are only available during a puzzle.');
    const round = this.round;
    if (puzzleId !== round.id) return fail('STALE', 'That hint was for a puzzle you have already moved past.');
    const h = round.hints[role];
    if (!h) return fail('NOT_ALLOWED', 'Unknown role.');
    if (h.shown >= HINTS_PER_ROLE) return fail('NO_MORE_HINTS', 'You have every hint for this puzzle.');
    const wait = h.shown === 0 ? 0 : h.lastAt + HINT_COOLDOWN_MS - now;
    if (wait > 0) return fail('COOLDOWN', 'The next hint is not ready yet.', { retryInMs: wait });
    h.shown++;
    h.lastAt = now;
    this.run.hints++;
    return { ok: true, tier: h.shown };
  }

  /** Everything one role is allowed to know. Never includes answers or the other role's data. */
  viewFor(role, now) {
    const view = { phase: this.phase, mode: this.mode };
    const run = this.run;
    if (!run) return view;
    view.stageId = run.stageId;
    view.runId = run.id;
    view.puzzleIndex = run.index;
    view.puzzles = run.rounds.map((r) => ({ type: r.type, level: r.level, title: MECHANICS[r.type].title, solved: r.solved }));
    view.timer = {
      limitMs: this.limitMs(),
      remainingMs: this.remaining(now),
      activeMs: this.activeMs(now),
      parMs: this.stage.parMs,
      running: this.playing && run.runningSince != null && run.runningSince <= now,
      // Ms until the clock starts again after a change-over (0 if not waiting).
      resumesInMs: this.playing && run.runningSince != null ? Math.max(0, run.runningSince - now) : 0,
    };
    if (this.playing) {
      const round = this.round;
      const def = PUZZLES[round.type];
      const h = round.hints[role];
      view.puzzle = {
        id: round.id,
        type: round.type,
        level: round.level,
        title: MECHANICS[round.type].title,
        number: run.index + 1,
        attempts: round.attempts,
        view: def.views[role](round.state),
        hints: def.hints[role].slice(0, h.shown).map((fn) => fn(round.state)),
        hintsTotal: HINTS_PER_ROLE,
        nextHintInMs: h.shown === 0 || h.shown >= HINTS_PER_ROLE ? 0 : Math.max(0, h.lastAt + HINT_COOLDOWN_MS - now),
      };
    }
    if (this.result) view.result = this.result;
    return view;
  }

  /** Plain data for persistence. A running clock is banked: on restore, play resumes when both players are back. */
  toJSON(now) {
    const run = this.run ? { ...this.run, activeMs: this.activeMs(now), runningSince: null } : null;
    return { mode: this.mode, phase: this.phase, run, result: this.result };
  }

  static fromJSON(data, { rng = cryptoRng } = {}) {
    const game = new Game({ mode: data.mode, rng });
    if (!PHASES.includes(data.phase)) return game;
    const run = data.run;
    const valid = run && stageById(run.stageId) && Array.isArray(run.rounds) && run.rounds.every((r) => PUZZLES[r.type]);
    if (!valid) return game;
    game.phase = data.phase;
    game.run = { ...run, runningSince: null };
    game.result = data.result || null;
    return game;
  }
}
