# Last Call

A two-player co-operative puzzle game for the browser.

Two players are trapped in the abandoned telephone exchange of Exchange 7. **The Caller** is inside: they see the symbols, lamps and machines. **The Operator** holds the field manual: they know what everything means but can't see any of it. Talk it through and solve three puzzles before the exchange forgets you.

- Real-time rooms with a share link or a 6-character room code, playable across devices
- Each player's browser only ever receives its own role's clues; answers are checked on the server
- Built-in chat with delivery status, retry and an offline queue; works alongside a phone or voice call
- Three hints per role per puzzle, each clearer than the last
- Atmospheric music and sound generated in the browser, with volume and mute controls
- Works with keyboard and screen readers, respects reduced-motion settings, and fits phones and desktops

## Run it on your computer

You need [Node.js](https://nodejs.org/) 20.12 or newer (the LTS download is fine). Open a terminal in this folder:

- **Windows:** in File Explorer, open the folder, type `powershell` in the address bar and press Enter. Command Prompt works too.
- **macOS:** open Terminal and run `cd ` followed by the folder path (you can drag the folder into the window).
- **Linux:** open a terminal and `cd` into the folder.

Then, on every system:

```bash
npm install   # first time only
npm start     # every time you want to play
```

The terminal shows the address to open, usually <http://localhost:3000>, plus addresses that other devices on the same Wi-Fi can use (for example `http://192.168.1.20:3000`). Open the game through one of those network addresses before you copy an invite link, and the link will work from a friend's phone on the same network. Press **Ctrl+C** in the terminal to stop the server.

To play both roles on one computer, open the invite link in a second browser or a private window. One browser profile holds one seat per room.

**Use a different port** if 3000 is taken:

| System | Command |
|--------|---------|
| Windows (PowerShell) | `$env:PORT=3001; npm start` |
| Windows (Command Prompt) | `set PORT=3001 && npm start` |
| macOS / Linux | `PORT=3001 npm start` |

You can also put settings in a `.env` file (copy `.env.example`); see [Environment variables](#environment-variables).

**If it doesn't start,** the terminal says why and what to do. The usual causes:
- **Dependencies are not installed.** Run `npm install` once.
- **Port already in use.** Close the other program, or pick another port as shown above.

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

**If the connection drops,** the game keeps your seat and reconnects by itself.
- **Short drop:** after a few seconds a banner explains what's happening, counts down to the next attempt, and offers **Try now**.
- **Server restarted:** the room is gone (see [Known limitations](#known-limitations)), so the game takes you back to the start with an explanation. Open a new room and send your partner the new link.

## Deploy for public play

Last Call is **one app on one server**. A single Node process serves the page, the room API and the WebSocket. Rooms live in that process's memory, so:

- **Run exactly one instance.** Don't turn on autoscaling or add instances: players on different instances would never find each other's rooms.
- **A restart or redeploy ends games in progress.** Players are told the server restarted and can open a new room straight away.

The repository is set up for **[Render](https://render.com)** through [`render.yaml`](render.yaml). It describes one web service on Render's free plan, with these settings:

| Setting | Value |
|---------|-------|
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Node version | `.node-version` (24) |
| Environment | `TRUST_PROXY=1`, `CLIENT_IP_HEADER=cf-connecting-ip`, `LOG_LEVEL=info`, narrator off |
| Auto-deploy | every push to `main`, after the GitHub CI checks pass |

### First deployment (about 5 minutes)

1. Sign in at <https://dashboard.render.com> with your GitHub account, and allow Render to access the `last-call` repository.
2. Choose **New > Blueprint**, pick the `last-call` repository, and confirm the `main` branch.
3. Render shows the `last-call` web service from `render.yaml`. It asks for `ANTHROPIC_API_KEY`: leave it blank unless you want the optional narrator. Then choose **Deploy Blueprint** (or **Apply**).
4. Wait for the first deploy to finish (a few minutes). The service page shows your public address, such as `https://last-call-xxxx.onrender.com`.
5. Check it: open `https://<your-address>/healthz` and look for `"status":"ok"`. Then open the address itself, open a room, and join from a second device.

To use your own domain, add it under the service's **Settings > Custom Domains**. Render provides the HTTPS certificate.

### Free or paid plan

The free plan costs nothing, but:
- **It sleeps** after 15 minutes without players. The next visitor waits about a minute while it wakes, and any rooms from before it slept are gone.
- **Render may restart free services at any time**, which also ends games in progress.

For an always-on server, change `plan: free` to `plan: starter` in `render.yaml` (or pick an instance type in the dashboard). Starter is a paid plan.

### HTTPS and WebSockets

The game needs a host that keeps long-lived WebSocket connections open on the same address as the page.
- **On HTTPS** the browser automatically uses secure WebSockets (`wss://`). The server adds `Strict-Transport-Security` when it sees HTTPS through a trusted proxy (`TRUST_PROXY=1`).
- **Behind your own proxy:** it must forward `Upgrade` and `Connection` headers and keep the original `Host` header, because the security policy and the WebSocket origin check use it.
- **On a different domain:** if the page is served from a different domain than the server, add it to `ALLOWED_ORIGINS`.

Static hosts (GitHub Pages, plain Netlify or Vercel sites) and serverless functions can't run the WebSocket server.

### Health check and shutdown

- **Health check.** `GET /healthz` (or `HEAD`) returns `200` with `{"status":"ok","uptimeSeconds":…,"rooms":…,"players":…}`. Use `players` to see whether anyone is mid-game before you redeploy.
- **Shutdown.** On `SIGTERM` (sent by hosts before stopping or replacing the server) or Ctrl+C, the server:
  1. switches to draining: `/healthz` returns `503`, and new rooms, joins and connections are refused with "the server is restarting";
  2. tells every connected player that their room closed because the server is restarting;
  3. closes all connections and exits, usually within a second, with a 10-second hard limit.

### Logs

The server writes one line per event to standard output, for example:

```
2026-10-31T09:12:03.477Z INFO  Last Call is running port=10000 node=v24.11.0 narrator="built-in lines"
2026-10-31T09:14:40.002Z INFO  room opened room=K7QM3X mode=timed rooms=1
2026-10-31T09:41:12.950Z INFO  room closed room=K7QM3X reason=idle rooms=0
2026-10-31T10:02:00.118Z INFO  shutting down reason=SIGTERM rooms=2 players=3
```

- **Where to read them:** on Render, the service's **Logs** tab. Locally, the terminal.
- **What's logged:** rooms opening and closing, start-up and shutdown, and errors with their stack traces.
- **What's never logged:** chat messages, player names or seat tokens.
- **Detail level:** set `LOG_LEVEL` to `debug`, `info`, `warn` or `error`.

### Redeploying

- **Normal path:** push to `main`. GitHub Actions runs the lint and tests, and Render deploys only once they pass. Each deploy restarts the server and ends games in progress, so prefer quiet times (check `players` on `/healthz`).
- **Manually:** on the Render service page, choose **Manual Deploy > Deploy latest commit**.
- **To roll back:** open **Events** and choose **Rollback** on an earlier deploy.
- **To change settings:** use the service's **Environment** tab. Saving redeploys the service.

### Other hosts

Any host that runs one long-lived Node process with WebSockets works.
- **Build:** `npm ci --omit=dev`
- **Start:** `npm start`
- **Health check:** `/healthz`
- **Settings:** set `TRUST_PROXY=1` behind the host's proxy (plus `CLIENT_IP_HEADER` if the host provides a trustworthy client-IP header), and keep it to one instance.

**Railway.** Deploy from the repository and set `TRUST_PROXY=1`.

**Fly.io.** Run `fly launch`, keep one machine (`fly scale count 1`), and set `TRUST_PROXY=1`.

**Your own server** behind nginx. Run the app under a process manager such as systemd or pm2, and pass WebSocket upgrades through:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

## Environment variables

All are optional.
- **Locally:** copy `.env.example` to `.env`; the server reads it on start.
- **On a host:** set them in the dashboard.
- **Secrets:** never commit `.env` or a real API key. `.env` is git-ignored, and `.env.example` holds placeholders only.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port. Render and most hosts set this for you. |
| `HOST` | `0.0.0.0` | Bind address. |
| `TRUST_PROXY` | `false` | Set to `1` behind a reverse proxy or a platform like Render, Railway or Fly. Rate limits then see real client IPs (the last `X-Forwarded-For` entry), and HTTPS is detected. Leave it off when nothing sits in front of the server, or clients could spoof their IP. |
| `CLIENT_IP_HEADER` | none | With `TRUST_PROXY=1`: a header that holds the real client IP and that clients can't forge through your proxy. Use `cf-connecting-ip` on Render (which sits behind Cloudflare; `render.yaml` sets it) or `fly-client-ip` on Fly.io. Unset means the last `X-Forwarded-For` entry is used. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
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
npm test        # node:test: puzzles, game rules, rooms, health and shutdown, two-client WebSocket session
npm run check   # both
```

There is no build step: the browser loads the files in `public/` and `shared/` as they are. GitHub Actions runs `npm run check` on every push to `main` and on pull requests ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## How it works

```
public/           Browser client (plain HTML, CSS and ES modules, no build step)
  js/main.js      Screens, room flow, timer, hints, connection banner, end of game
  js/net.js       Room API calls and the self-reconnecting WebSocket
  js/chat.js      Chat panel: pending, failed and queued messages, retries
  js/caller.js    The Caller's machines (dial, patch bay, teleprinter)
  js/manual.js    The Operator's field manual
  js/audio.js     Procedural music and sound effects (Web Audio)
shared/           Code used by both sides: room-code rules, glyph and stamp artwork
server/
  index.js        Entry point: start-up checks, logging, graceful shutdown
  app.js          HTTP API, health check, static files, WebSocket handling, rate limits
  rooms.js        Rooms, seats, reconnection, chat history, expiry
  game.js         Game state, timer, answer checking, hint pacing
  puzzles/        One module per puzzle: generation, role views, answer check, hints
  narrator.js     Optional Claude-written atmosphere lines
  logger.js       One-line timestamped logs
test/             Node test runner suites (unit, lifecycle and two-client integration)
render.yaml       Render Blueprint (one web service)
```

**The server is the authority.** It generates each puzzle, keeps the answers, and sends each player a view built only for their role. The Caller's browser never receives the manual, and the Operator's browser never receives the machine data. Neither receives an answer. Each puzzle module defines its views, answer check and hints together, so the clues, the validation and the hints can't drift apart. The tests check this for hundreds of random puzzles.

**Rooms and seats.**
- **Room codes** are 6 random characters from an alphabet without look-alikes (no I, L, O, 0 or 1).
- **Seat tokens.** Joining gives your browser a random 128-bit seat token. It's kept in `localStorage`, so a reload or a dropped connection puts you straight back in your seat.
- **Taking over a seat.** If a player has been gone for more than 20 seconds, someone joining with the code can take their seat.
- **Another tab.** Opening the same seat in a second tab moves the connection there, and the first tab says so.

**Reconnection.** The client reconnects on its own, backing off from about half a second up to 10 seconds. It also reconnects straight away when the network or the tab comes back. Chat messages sent while offline wait in a queue and are sent on reconnect. The server ignores duplicate retries.

**Detecting dead connections.**
- **The browser** sends an app-level ping every 15 seconds. If a ping gets no reply within 10 seconds, it drops the connection and reconnects.
- **The server** drops a connection after 90 seconds without any message. It doesn't rely on WebSocket ping frames alone, because some hosting proxies (including Render's) answer those themselves even after the player has gone.
- **The 90-second limit** leaves room for background tabs, whose timers browsers may slow to once a minute.

**Expiry.**
- A room closes after `ROOM_IDLE_MINUTES` with nobody connected, and in any case after `ROOM_MAX_HOURS`.
- For 12 hours afterwards, the code is remembered as "closed", so players see why the room is gone rather than "no such room".

**Limits and hardening.**
- **Rate limits:**
  - room creation: 8 per IP every 10 minutes
  - code lookups and joins: 40 per IP every 5 minutes
  - WebSocket connections: 30 per IP per minute, at most 12 open at once
  - messages per socket, chat per player, and answer attempts are throttled too
- **Message sizes:** WebSocket messages are capped at 8 KB, chat messages at 400 characters, and names at 20.
- **Input cleaning:** control and bidi-override characters are stripped. Chat is always rendered as text, never HTML.
- **Headers:** responses carry a strict Content-Security-Policy, `Referrer-Policy: no-referrer` (so room codes in URLs never leak), `X-Frame-Options: DENY` and `nosniff`. WebSocket connections from other sites are refused.

## Known limitations

- Rooms are in memory: a server restart, redeploy or free-plan sleep ends games in progress. Players are told what happened and can open a new room.
- One instance only, for the same reason.
- There's no built-in voice chat. Players who want to talk can use a phone or voice call alongside the in-game chat.
- One seat per browser profile per room. Use a second browser or a private window to play both roles on one machine.
