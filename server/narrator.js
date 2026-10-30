// "The Exchange" posts one short atmospheric line into the chat after key moments.
// Hand-written lines are always available. When ENABLE_AI_NARRATOR is on and an
// ANTHROPIC_API_KEY is set, the line is written by Claude instead. The request
// never includes answers, clues or player names, and the key stays on the server.

import { RateLimiter } from './rateLimit.js';

const LINES = {
  solved: [
    'Somewhere below you, a relay that has not moved in sixty years closes with a sigh.',
    'The dust on the switchboard shifts, as if something leaned in to listen.',
    'A dial tone hums through the walls, faint and patient.',
    'One more lamp burns steady. The exchange is starting to remember your voices.',
  ],
  won: [
    'The line clicks open. A tired voice says "Number please?" and then, softly, "Thank you for calling back."',
    'Every lamp on the board lights at once, then dims to a warm, sleeping glow. You are remembered.',
  ],
  lost: [
    'The lamps go out one by one. The exchange has already forgotten what you sounded like.',
    'A recorded voice: "The number you have dialled is no longer in service." Then nothing at all.',
  ],
};

const SYSTEM = `You are "The Exchange", the voice of an abandoned 1960s telephone exchange in a co-operative puzzle game with a quiet, eerie tone.
Write exactly one sentence of at most 28 words describing what the players hear or sense in the building after the event you are given.
Stay atmospheric and unsettling but never gory. Do not address the players by name, do not give puzzle advice, and do not mention codes, digits, colours, letters or answers.
Reply with the sentence only.`;

function pickLine(event) {
  const pool = LINES[event] || LINES.solved;
  return pool[Math.floor(Math.random() * pool.length)];
}

function describe({ event, title, progress }) {
  if (event === 'won') return 'Event: the players solved the final puzzle and the last call connects.';
  if (event === 'lost') return 'Event: the players ran out of time and the exchange forgets them.';
  return `Event: the players just solved the puzzle "${title}" (${progress} of 3 solved).`;
}

function tidy(text) {
  const line = text.replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
  return line.length >= 8 && line.length <= 280 ? line : null;
}

export function createNarrator({ enabled, apiKey, model }, { log = console } = {}) {
  let client = null;
  let warned = false;
  // Keeps a busy server from turning flavour text into a large bill.
  const budget = new RateLimiter({ capacity: 30, perMs: 60_000 });

  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 });
    }
    return client;
  }

  return {
    enabled,
    async line(context) {
      const fallback = pickLine(context.event);
      if (!enabled || budget.take('global') > 0) return fallback;
      try {
        const anthropic = await getClient();
        const response = await anthropic.beta.messages.create({
          model,
          max_tokens: 2000,
          output_config: { effort: 'low' },
          // If a request is declined, let the API retry it on its recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          messages: [{ role: 'user', content: describe(context) }],
        });
        if (response.stop_reason === 'refusal') return fallback;
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ');
        return tidy(text) || fallback;
      } catch (err) {
        if (!warned) {
          warned = true;
          log.warn(`[narrator] Claude request failed, using built-in lines: ${err?.status ?? ''} ${err?.message ?? err}`);
        }
        return fallback;
      }
    },
  };
}
