import { PUZZLES } from './puzzles/index.js';
import { cryptoRng } from './random.js';

export const TIME_LIMIT_MS = 25 * 60_000;
export const WRONG_PENALTY_MS = 30_000;
export const ANSWER_COOLDOWN_MS = 2_500;
export const HINT_COOLDOWN_MS = 30_000;
export const HINTS_PER_ROLE = 3;
/** Partial-match feedback ("2 of 4 relays held") starts on this attempt. */
export const FEEDBACK_FROM_ATTEMPT = 2;

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/**
 * One run through the puzzles. Holds every secret (answers, both roles' data)
 * and only ever hands out role-filtered views via `viewFor`.
 */
export class Game {
  constructor({ mode = 'timed', rng = cryptoRng, puzzles = PUZZLES } = {}) {
    this.mode = mode;
    this.rng = rng;
    this.defs = puzzles;
    this.status = 'lobby';
    this.puzzleIndex = 0;
    this.rounds = [];
    this.elapsedMs = 0;
    this.runningSince = null;
    this.lastAnswerAt = -Infinity;
    this.totals = { attempts: 0, hints: 0 };
  }

  get round() {
    return this.rounds[this.puzzleIndex];
  }

  get timed() {
    return this.mode === 'timed';
  }

  get paused() {
    return this.status === 'playing' && this.runningSince == null;
  }

  start(now) {
    if (this.status !== 'lobby') return false;
    this.rounds = this.defs.map((def) => ({
      def,
      state: def.generate(this.rng),
      attempts: 0,
      solved: false,
      hints: { caller: { shown: 0, lastAt: 0 }, operator: { shown: 0, lastAt: 0 } },
    }));
    this.status = 'playing';
    this.puzzleIndex = 0;
    this.elapsedMs = 0;
    this.runningSince = now;
    return true;
  }

  elapsed(now) {
    return this.elapsedMs + (this.runningSince == null ? 0 : now - this.runningSince);
  }

  remaining(now) {
    return this.timed ? Math.max(0, TIME_LIMIT_MS - this.elapsed(now)) : null;
  }

  pause(now) {
    if (this.runningSince == null) return false;
    this.elapsedMs += now - this.runningSince;
    this.runningSince = null;
    return true;
  }

  resume(now) {
    if (this.status !== 'playing' || this.runningSince != null) return false;
    this.runningSince = now;
    return true;
  }

  /** Ends the run if the exchange has run out of patience. Returns true if it just ended. */
  checkTimeout(now) {
    if (this.status === 'playing' && this.timed && this.remaining(now) <= 0) {
      this.finish('lost', now);
      return true;
    }
    return false;
  }

  finish(status, now) {
    this.pause(now);
    this.status = status;
  }

  submitAnswer(role, raw, now) {
    if (this.status !== 'playing') return fail('NOT_PLAYING', 'There is nothing to answer right now.');
    if (role !== 'caller') return fail('NOT_ALLOWED', 'Only the Caller can operate the machines.');
    if (this.paused) return fail('PAUSED', 'The line is paused until your partner reconnects.');
    const wait = this.lastAnswerAt + ANSWER_COOLDOWN_MS - now;
    if (wait > 0) return fail('COOLDOWN', 'The machine is still resetting. Try again in a moment.', { retryInMs: wait });

    const round = this.round;
    const parsed = round.def.parseAnswer(raw);
    if (parsed.error) return fail('INVALID', parsed.error);

    this.lastAnswerAt = now;
    round.attempts++;
    this.totals.attempts++;
    const result = round.def.check(round.state, parsed.value);

    if (result.correct) {
      round.solved = true;
      const solvedTitle = round.def.title;
      if (this.puzzleIndex === this.rounds.length - 1) {
        this.finish('won', now);
      } else {
        this.puzzleIndex++;
      }
      return { ok: true, correct: true, solvedTitle, won: this.status === 'won' };
    }

    let penaltyMs = 0;
    if (this.timed) {
      penaltyMs = WRONG_PENALTY_MS;
      this.elapsedMs += penaltyMs;
    }
    const lost = this.checkTimeout(now);
    const feedback =
      round.attempts >= FEEDBACK_FROM_ATTEMPT ? { matched: result.matched, total: result.total, unit: result.unit } : null;
    return { ok: true, correct: false, penaltyMs, feedback, attempts: round.attempts, lost };
  }

  requestHint(role, now) {
    if (this.status !== 'playing') return fail('NOT_PLAYING', 'Hints are only available during a puzzle.');
    const round = this.round;
    const h = round.hints[role];
    if (!h) return fail('NOT_ALLOWED', 'Unknown role.');
    if (h.shown >= HINTS_PER_ROLE) return fail('NO_MORE_HINTS', 'You have every hint for this puzzle.');
    const wait = h.shown === 0 ? 0 : h.lastAt + HINT_COOLDOWN_MS - now;
    if (wait > 0) return fail('COOLDOWN', 'The next hint is not ready yet.', { retryInMs: wait });
    const text = round.def.hints[role][h.shown](round.state);
    h.shown++;
    h.lastAt = now;
    this.totals.hints++;
    return { ok: true, tier: h.shown, text };
  }

  /** Everything one role is allowed to know. Never includes answers or the other role's data. */
  viewFor(role, now) {
    const view = {
      status: this.status,
      mode: this.mode,
      puzzleIndex: this.puzzleIndex,
      progress: this.defs.map((def, i) => ({ title: def.title, solved: Boolean(this.rounds[i]?.solved) })),
      timer: {
        limitMs: this.timed ? TIME_LIMIT_MS : null,
        remainingMs: this.status === 'lobby' ? (this.timed ? TIME_LIMIT_MS : null) : this.remaining(now),
        elapsedMs: this.status === 'lobby' ? 0 : this.elapsed(now),
        running: this.runningSince != null,
      },
    };
    if (this.status === 'playing') {
      const round = this.round;
      const h = round.hints[role];
      view.puzzle = {
        id: round.def.id,
        title: round.def.title,
        number: this.puzzleIndex + 1,
        attempts: round.attempts,
        view: round.def.views[role](round.state),
        hints: round.def.hints[role].slice(0, h.shown).map((fn) => fn(round.state)),
        hintsTotal: HINTS_PER_ROLE,
        nextHintInMs: h.shown === 0 || h.shown >= HINTS_PER_ROLE ? 0 : Math.max(0, h.lastAt + HINT_COOLDOWN_MS - now),
      };
    }
    if (this.status === 'won' || this.status === 'lost') {
      view.result = {
        elapsedMs: this.elapsed(now),
        solved: this.rounds.filter((r) => r.solved).length,
        attempts: this.totals.attempts,
        hints: this.totals.hints,
      };
    }
    return view;
  }
}
