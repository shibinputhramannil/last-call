# Last Call

A two-player co-operative puzzle game for the browser.

Two players are trapped in the abandoned telephone exchange of Exchange 7. **The Caller** is inside: they see the symbols, lamps and machines. **The Operator** holds the field manual: they know what everything means but can't see any of it. Talk it through and solve three puzzles before the exchange forgets you.

- Real-time rooms with a share link or a 6-character room code, playable across devices
- Each player's browser only ever receives its own role's clues; answers are checked on the server
- Built-in chat with delivery status, retry and an offline queue; works alongside a phone or voice call
- Three hints per role per puzzle, each clearer than the last
- Atmospheric music and sound generated in the browser, with volume and mute controls
- Works with keyboard and screen readers, respects reduced-motion settings, and fits phones and desktops

## Quick start

You need [Node.js](https://nodejs.org/) 20.12 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. To try both roles on one computer, open the invite link in a second browser or a private window, because the same browser profile shares one seat per room.

**Playing on two devices on the same network:** open the game using your computer's network address instead of `localhost`, for example `http://192.168.1.20:3000`. Invite links use whatever address the page was opened with, so they then work from a phone on the same Wi-Fi.

For development, `npm run dev` restarts the server when server files change. The client has no build step; reload the page to see changes.

## How to play

1. One player chooses **Open a room**, picks a role and a clock, and sends the invite link (or reads out the room code).
2. The other player opens the link, or types the code under **Join a friend**.
3. When both of you are on the line, either player presses **Start**. You can swap roles in the lobby first.

**The Caller** describes what they see and works the machines: they're the only one who can dial, patch or type an answer.
**The Operator** asks questions, looks things up in the manual and gives instructions. The manual has a private notepad.

The puzzles:

| # | Puzzle | Caller sees | Operator has |
|---|--------|-------------|--------------|
| 1 | The Dead Line | Four glyph plates, a signal lamp, a rotary dial | A glyph directory and the lamp rules |
| 2 | The Patch Bay | Ringing lines with lamp colours and stamped shapes, six trunk jacks | A routing grid and the busy-trunk rule |
| 3 | The Last Call | A punched tape and a labelled reel | The tape code, the reel rule and the staff roster |

Each room gets freshly randomised puzzles, so answers can't be shared between games.

**Clock.** In a timed game you have 25 minutes. Each wrong answer costs 30 seconds. From the second wrong attempt on a puzzle, the exchange also tells you how much was right (for example "2 of 4 relays held"). Choose **No clock** for a relaxed game. If either player disconnects, the clock is held until both are back.

**Hints.** Each player has three hints per puzzle, written for their own role. The first is available at once. Each later one unlocks 30 seconds after the previous one, so you try talking it through first. Your partner sees that you read a hint, but not what it said.

**Keyboard.** Everything works without a mouse. On the rotary dial you can also type digits, use Backspace to remove one, and press Enter to connect. In chat, Enter sends and Shift+Enter adds a new line.

## How it works

```
public/           Browser client (plain HTML, CSS and ES modules, no build step)
  js/main.js      Screens, room flow, timer, hints, end of game
  js/net.js       Room API calls and the self-reconnecting WebSocket
  js/chat.js      Chat panel: pending, failed and queued messages, retries
  js/caller.js    The Caller's machines (dial, patch bay, teleprinter)
  js/manual.js    The Operator's field manual
  js/audio.js     Procedural music and sound effects (Web Audio)
shared/           Code used by both sides: room-code rules, glyph and stamp artwork
server/
  index.js        Entry point
  app.js          HTTP API, static files, WebSocket handling, rate limits
  rooms.js        Rooms, seats, reconnection, chat history, expiry
  game.js         Game state, timer, answer checking, hint pacing
  puzzles/        One module per puzzle: generation, role views, answer check, hints
  narrator.js     Optional Claude-written atmosphere lines
test/             Node test runner suites (unit and two-client integration)
```

**The server is the authority.** It generates each puzzle, keeps the answers, and sends each player a view built only for their role. The Caller's browser never receives the manual, and the Operator's browser never receives the machine data. Neither receives an answer. Each puzzle module defines its views, answer check and hints together, so the clues, the validation and the hints can't drift apart. The tests check this for hundreds of random puzzles.

**Rooms and seats.**
- **Room codes** are 6 random characters from an alphabet without look-alikes (no I, L, O, 0 or 1).
- **Seat tokens.** Joining gives your browser a random 128-bit seat token. It's kept in `localStorage`, so a reload or a dropped connection puts you straight back in your seat.
- **Taking over a seat.** If a player has been gone for more than 20 seconds, someone joining with the code can take their seat.
- **Another tab.** Opening the same seat in a second tab moves the connection there, and the first tab says so.

**Reconnection.** The client reconnects on its own, backing off from about half a second up to 10 seconds. It also reconnects straight away when the network or the tab comes back. A heartbeat in both directions detects dead connections. Chat messages sent while offline wait in a queue and are sent on reconnect. The server ignores duplicate retries.

**Expiry.**
- A room closes after `ROOM_IDLE_MINUTES` with nobody connected, and in any case after `ROOM_MAX_HOURS`.
- For 12 hours afterwards, the code is remembered as "closed", so players see why the room is gone rather than "no such room".
- Rooms live in memory, so restarting the server ends every game. Players are told the room no longer exists.

**Limits and hardening.**
- **Rate limits:**
  - room creation: 8 per IP every 10 minutes
  - code lookups and joins: 40 per IP every 5 minutes
  - WebSocket connections: 30 per IP per minute, at most 12 open at once
  - messages per socket, chat per player, and answer attempts are throttled too
- **Message sizes:** WebSocket messages are capped at 8 KB, chat messages at 400 characters, and names at 20.
- **Input cleaning:** control and bidi-override characters are stripped. Chat is always rendered as text, never HTML.
- **Headers:** responses carry a strict Content-Security-Policy, `Referrer-Policy: no-referrer` (so room codes in URLs never leak), `X-Frame-Options: DENY` and `nosniff`. WebSocket connections from other sites are refused.

## Environment variables

All are optional. Copy `.env.example` to `.env` for local use; the server loads it on start. Never commit `.env`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port. Most hosts set this for you. |
| `HOST` | `0.0.0.0` | Bind address. |
| `TRUST_PROXY` | `false` | Set to `1` behind a reverse proxy or a platform like Render, Railway or Fly, so rate limits see real client IPs (taken from the last `X-Forwarded-For` entry). Leave it off when nothing sits in front of the server, or clients could spoof their IP. |
| `ALLOWED_ORIGINS` | none | Extra comma-separated origins allowed to open the game's WebSocket. The page's own origin is always allowed. |
| `ROOM_IDLE_MINUTES` | `30` | Close a room after this long with nobody connected. |
| `ROOM_MAX_HOURS` | `4` | Close every room after this long, regardless of activity. |
| `ENABLE_AI_NARRATOR` | `false` | Turn on the optional Claude narrator (also needs a key). |
| `ANTHROPIC_API_KEY` | none | Claude API key, used only by the server. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model the narrator uses. |

### Optional: the Claude narrator

After each solved puzzle and at the end of a game, "The Exchange" posts one short, eerie line in the chat. By default these lines come from a built-in set, and the game needs no API key.

To have Claude write them instead, set both `ENABLE_AI_NARRATOR=true` and `ANTHROPIC_API_KEY` on the server.

- **What's sent:** only the event (for example "solved The Patch Bay, 2 of 3"). Never answers, clues, player names or chat.
- **Safeguards:** calls are capped at 30 per minute across the server. If a call fails, times out or is declined, the built-in line is used.
- **Model:** it runs on `claude-opus-5-5` at low effort, with the API's refusal fallback switched on. Set `ANTHROPIC_MODEL` to use a different model.

The key is read from the environment on the server and is never sent to browsers.

## Checks

```bash
npm run lint    # ESLint over server, client and tests
npm test        # node:test: puzzles, game rules, rooms, narrator, two-client WebSocket session
npm run check   # both
```

## Deployment

Last Call is one Node process that serves the page, the API and the WebSocket. Any host that runs Node and supports WebSockets will do. **Run a single instance:** rooms are held in memory, so two instances would not see each other's rooms. Under HTTPS the client automatically uses secure WebSockets (`wss://`). `GET /healthz` returns `{"ok":true}` for health checks.

**Render.** Create a Web Service from this repository.
- Build command: `npm install`
- Start command: `npm start`
- Environment: `TRUST_PROXY=1`
- Health check path: `/healthz`

**Railway.** Deploy from the repository; it detects `npm start`. Set `TRUST_PROXY=1`.

**Fly.io.** Run `fly launch`, keep one machine (`fly scale count 1`), and set `TRUST_PROXY=1` with `fly secrets set` (or in `fly.toml`).

**Your own server** (behind nginx). Run `npm ci --omit=dev && npm start` under a process manager such as systemd or pm2, set `TRUST_PROXY=1`, and pass WebSocket upgrades through:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
```

Static hosts such as GitHub Pages or plain Netlify and Vercel sites can't run the WebSocket server. Use one of the options above.

If you turn on the narrator, add `ENABLE_AI_NARRATOR` and `ANTHROPIC_API_KEY` as secrets in your host's settings, not in the repository.

## Known limitations

- Rooms are in memory: a server restart or redeploy ends games in progress.
- There's no built-in voice chat. Players who want to talk can use a phone or voice call alongside the in-game chat.
- One seat per browser profile per room. Use a second browser or a private window to play both roles on one machine.
