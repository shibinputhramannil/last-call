# Last Call

A two-player co-operative puzzle game for the browser. **Play it: <https://last-call-vdui.onrender.com>**

Exchange 7 closed in 1963, and tonight one of its lines rang anyway. **The Caller** is inside the exchange: they see the symbols, lamps and machines. **The Operator** holds the night staff's field manual: they know what everything means but can't see any of it. Talk it through, restore the lines stage by stage, and connect the last call.

- A campaign of **200 stages in 10 chapters**, each stage three puzzles, with a story beat for every stage
- Six puzzle machines (symbol decoding, routing, punched tape, ring patterns, relay sequences and a telegram cipher) that grow harder through the chapters
- Up to **three stars per stage**, with the score worked out in front of you
- Real-time rooms with an invite link or a 6-character room code, across devices
- Each browser only ever receives its own role's clues; every answer is checked on the server
- Chat with delivery receipts and automatic retries; it keeps unsent messages through drops and reloads
- Reconnects by itself and resumes the same room, role, stage, puzzle, chat and score
- Progress is saved in both players' browsers, signed by the server, so it survives server restarts
- Settings for sound, music, motion, text size, contrast and the manual's typewriter font
- Keyboard and screen reader support, fits phones and desktops
- A private, two-factor Superadmin dashboard with live and historical play statistics (anonymous, no chat or names)

Security notes and the threat model are in [docs/SECURITY.md](docs/SECURITY.md).

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

You can also put settings in a `.env` file (copy `.env.example`); see [Environment variables](#environment-variables). Locally the server warns that `SAVE_SECRET` is not set; that only matters if you want saved progress to survive restarting your own server.

**If it doesn't start,** the terminal says why and what to do. The usual causes:
- **Dependencies are not installed.** Run `npm install` once.
- **Port already in use.** Close the other program, or pick another port as shown above.

For development, `npm run dev` restarts the server when server files change. The client has no build step; reload the page to see changes.

## How to play

1. On your first visit a short story sets the scene, one page at a time. Use **Next** and **Back**, or **Skip the story**. It won't show again; replay it any time from **Settings**.
2. One player chooses **Open a room**, picks a role, and sends the invite link (or reads out the room code). The other player opens the link, or types the code under **Join a friend**.
3. Pick a stage on the **stage map**. Either player can start it once both of you are on the line. You can swap roles between stages.

**The Caller** describes what they see and works the machines: they're the only one who can dial, patch, flip or type an answer.
**The Operator** asks questions, looks things up in the manual and gives instructions. The manual has a private notepad.

### The machines

| Machine | Caller sees | Operator has | Gets harder with |
|---------|-------------|--------------|------------------|
| The Dead Line | Glyph plates, signal lamps, a rotary dial | A glyph directory and the lamp rules | More plates, blanking plates, a day/night clock, two lamps, look-alike glyphs |
| The Patch Bay | Ringing lines with lamp colours and stamped shapes, trunk jacks | A routing grid and the routing rules | More calls and trunks, busy trunks, out-of-order trunks, red priority, stepping backwards |
| The Teleprinter | A punched tape and a labelled reel | The tape code, reel rules and staff roster | Longer names, spacers, upside-down tape, shifted letters |
| The Party Line | A log of rings, each a pattern of long and short | Whose ring is whose, and the ring-back rules | More households, counting rings, ignoring echoes, trunk rings counting twice |
| The Relay Rack | Coloured relays, up or down, and fault lamps | A job for each fault lamp | More relays and lamps, jobs that depend on the rack "right now", conditions |
| The Cipher Wheel | An enciphered telegram, its stamps, a wheel's pointer | The wheel key table, cipher rules and codebook | Bigger shifts, stamps that add to the shift, alternating directions |

Every room gets freshly generated puzzles, so answers can't be shared between games.

### Stages, chapters and progress

- A stage is **three puzzles**. Solve all three and the stage is restored: you get your stars and score, then **Continue** to the next stage, **Replay** for a better score, or go back to the **stage map**.
- Stages unlock in order: restoring a stage opens the next one. Each chapter has twenty stages and ends with a finale, its hardest stage. The campaign's ending comes only after the final stage, 10-20.
- New machines arrive chapter by chapter, starting gently. Later chapters add rules on top of rules rather than guesswork: everything you need is always on one of the two screens.
- **Progress is saved for you.** The server signs your team's progress (stars and best score for every stage) and gives it to both browsers. When you open or join a room later, the room starts from whichever of you has got furthest.

### Scoring and stars

Every stage starts at **1000 points**:

| What | Cost |
|------|------|
| Time beyond the stage's par time | 1 point per 2 seconds, at most 300 |
| Each wrong answer | 60 points, at most 300 |
| Each hint read (by either of you) | 40 points, at most 300 |

A score never drops below 100. **★★★ Excellent** is 850 or more, **★★ Good** is 600 to 849, and **★ Completed** is any finished stage. The results screen shows the arithmetic for every stage.

Only fair things count. The stage clock **stops whenever either player is disconnected** and during the change-over after each solved puzzle, so a network drop, a slow device, or the motion setting never costs points.

**Stage countdown.** Choose **Relaxed** (no countdown) or **Countdown** when you open a room, or in the lobby. With the countdown on, each stage has a time limit of about twice its par, wrong answers take 30 seconds off it, and if it runs out the stage fails and you can retry it with new puzzles. Stars work the same way in both modes.

**Hints.** Each player has three hints per puzzle, written for their own role, each clearer than the last. The first is available at once; each later one unlocks 30 seconds after the previous one. Your partner sees that you read a hint, but not what it said. From the second wrong attempt on a puzzle, the exchange also tells you how much was right (for example "2 of 4 relays held").

### Settings

The brass knob in the bottom-left corner opens **Settings** (on phones in a room it sits in the chat bar, so it never covers the game). It works with the keyboard: Tab through it and press Escape to close.

- **Sound:** mute, overall volume, music and sound effects. Nothing plays until you first click or press a key.
- **Motion:** match your device, reduce motion, or full motion.
- **Reading:** standard, large or larger text; higher contrast; and the typewriter font in the manual (turn it off for a plainer font).
- **Story:** replay the opening.

Settings are kept in your browser.

**Keyboard.** Everything works without a mouse. On the rotary dial you can type digits, use Backspace to remove one, and press Enter to connect. On the stage map, arrow keys move between stages. In chat, Enter sends and Shift+Enter adds a new line.

### If the connection drops

The game is built so that drops are calm and nothing is lost.

- **Connected, Reconnecting, Offline.** The status at the top tells you which. A blip shorter than a second and a half is never shown at all; after ten seconds a banner explains what is happening and offers **Try now**.
- **Your partner** sees "reconnecting" during a short drop, and nothing is posted in the chat. Only a drop longer than 8 seconds is announced, and the stage clock is held either way.
- **Reconnecting** happens by itself, almost at once for the first try, then backing off up to 15 seconds, and straight away when your network or the tab comes back.
- **Everything comes back:** the same room, role, stage, puzzle, chat history, score and progress, after a drop or a page reload.
- **Messages** you send while disconnected wait and go as soon as you are back. Each one is confirmed by the server; if a confirmation doesn't arrive, the game re-sends it automatically, and the server never posts a message twice. Unsent messages and your half-typed draft survive reloading the page.
- **If the server restarts** (for example after an update), players see "The game server is restarting" and their browsers reconnect when it is back. See [Persistence](#persistence) for exactly what is kept.

## Deploy for public play

Last Call is **one app on one server**. A single Node process serves the page, the room API and the WebSocket.

- **Run exactly one instance.** Don't turn on autoscaling or add instances: players on different instances would not find each other's rooms.

The repository is set up for **[Render](https://render.com)** through [`render.yaml`](render.yaml). It describes one web service on Render's free plan:

| Setting | Value |
|---------|-------|
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Node version | `.node-version` (24) |
| Environment | `TRUST_PROXY=1`, `CLIENT_IP_HEADER=cf-connecting-ip`, `LOG_LEVEL=info`, `SAVE_SECRET` (generated by Render), narrator off |
| Auto-deploy | every push to `main`, after the GitHub CI checks pass |

### First deployment (about 5 minutes)

1. Sign in at <https://dashboard.render.com> with your GitHub account, and allow Render to access the `last-call` repository.
2. Choose **New > Blueprint**, pick the `last-call` repository, and confirm the `main` branch.
3. Render shows the `last-call` web service from `render.yaml`. It asks for `ANTHROPIC_API_KEY`: leave it blank unless you want the optional narrator. Then choose **Deploy Blueprint** (or **Apply**).
4. Wait for the first deploy to finish (a few minutes). The service page shows your public address, such as `https://last-call-xxxx.onrender.com`.
5. Check it: open `https://<your-address>/healthz` and look for `"status":"ok"`. Then open the address itself, open a room, and join from a second device.

**Already deployed before `SAVE_SECRET` existed?** A Blueprint picks up the new variable on its next sync. Check the service's **Environment** tab: if `SAVE_SECRET` is missing, add it yourself with 32 or more random characters (see `.env.example` for a one-line generator). Without it the game still works, but saved progress and room tickets stop verifying after each restart.

To use your own domain, add it under the service's **Settings > Custom Domains** and set `PUBLIC_URL` to the new address, so share previews use it.

### Persistence

What survives a restart or redeploy depends on two settings:

| Setup | Campaign progress and best scores | Room, roles and code | Chat and the stage in progress |
|-------|-----------------------------------|----------------------|--------------------------------|
| `SAVE_SECRET` set (the Render default) | Kept: restored from both players' browsers | Kept: rebuilt from the players' signed tickets when they reconnect | Lost: the stage restarts with new puzzles |
| `SAVE_SECRET` and `DATA_DIR` on a persistent disk | Kept | Kept | Kept, including the stage clock |
| Neither | Kept only until the server restarts | Lost | Lost |

- **`SAVE_SECRET`** signs the progress and the room tickets that browsers keep. Browsers can't edit or forge them. Keep it stable: changing it makes every saved game unreadable. If it is not set but `DATA_DIR` is, the server creates one and keeps it in `DATA_DIR`.
- **`DATA_DIR`** saves each room as a small JSON file (written a moment after each change, and on shutdown) and reloads them at start-up. On Render this needs a **paid instance with a persistent disk**: uncomment the `disk` block and `DATA_DIR` in `render.yaml`. A disk turns off Render's zero-downtime deploys. On Fly.io, use a volume; on your own server, any writable folder.
- Rooms still close after `ROOM_IDLE_MINUTES` with nobody connected, and after `ROOM_MAX_HOURS` in any case. Your progress stays in your browser either way.

### Free or paid plan

The free plan costs nothing, but:
- **It sleeps** after 15 minutes without players (messages over an open WebSocket count as activity, so a game in progress keeps it awake). The next visitor waits about a minute while it wakes.
- **Render may restart free services at any time.** With `SAVE_SECRET` set, players reconnect into a rebuilt room with their progress intact.

For an always-on server, change `plan: free` to `plan: starter` in `render.yaml` (or pick an instance type in the dashboard). Starter is a paid plan.

### HTTPS and WebSockets

The game needs a host that keeps long-lived WebSocket connections open on the same address as the page.
- **On HTTPS** the browser automatically uses secure WebSockets (`wss://`). The server adds `Strict-Transport-Security` when it sees HTTPS through a trusted proxy (`TRUST_PROXY=1`).
- **Behind your own proxy:** it must forward `Upgrade` and `Connection` headers and keep the original `Host` header, because the security policy and the WebSocket origin check use it.
- **On a different domain:** if the page is served from a different domain than the server, add it to `ALLOWED_ORIGINS`.

Static hosts (GitHub Pages, plain Netlify or Vercel sites) and serverless functions can't run the WebSocket server.

### Health check and shutdown

- **Health check.** `GET /healthz` (or `HEAD`) returns `200` with `{"status":"ok"}`, and nothing else: player counts and history are only in the [admin dashboard](#admin-dashboard). Check "Players connected now" there before you redeploy.
- **Shutdown.** On `SIGTERM` (sent by hosts before stopping or replacing the server) or Ctrl+C, the server:
  1. switches to draining: `/healthz` returns `503`, and new rooms, joins and connections are refused with "the server is restarting";
  2. pauses every stage clock and saves every room (with `DATA_DIR`);
  3. tells every connected player it is restarting, so their browsers keep reconnecting instead of giving up;
  4. closes all connections and exits, usually within a second, with a 10-second hard limit.

### Logs

The server writes one line per event to standard output, for example:

```
2026-10-31T09:12:03.477Z INFO  Last Call is running port=10000 node=v24.11.0 narrator="built-in lines" rooms=memory
2026-10-31T09:14:40.002Z INFO  room opened room=K7QM3X mode=untimed rooms=1
2026-10-31T09:20:15.310Z INFO  room rebuilt from ticket room=K7QM3X rooms=1
2026-10-31T09:41:12.950Z INFO  room closed room=K7QM3X reason=idle rooms=0
```

- **Where to read them:** on Render, the service's **Logs** tab. Locally, the terminal.
- **What's logged:** rooms opening, closing and being restored, start-up and shutdown, and errors with their stack traces.
- **What's never logged:** chat messages, player names, seat tokens or secrets.
- **Detail level:** set `LOG_LEVEL` to `debug`, `info`, `warn` or `error`.

### Redeploying

- **Normal path:** push to `main`. GitHub Actions runs the lint and tests, and Render deploys only once they pass. Players in a game see "restarting" and reconnect; see [Persistence](#persistence) for what they keep. The admin dashboard shows whether anyone is playing.
- **Manually:** on the Render service page, choose **Manual Deploy > Deploy latest commit**.
- **To roll back:** open **Events** and choose **Rollback** on an earlier deploy.
- **To change settings:** use the service's **Environment** tab. Saving redeploys the service.

### Other hosts

Any host that runs one long-lived Node process with WebSockets works.
- **Build:** `npm ci --omit=dev`
- **Start:** `npm start`
- **Health check:** `/healthz`
- **Settings:** set `TRUST_PROXY=1` behind the host's proxy (plus `CLIENT_IP_HEADER` if the host provides a trustworthy client-IP header), set `SAVE_SECRET` and `PUBLIC_URL`, and keep it to one instance.

**Railway.** Deploy from the repository and set `TRUST_PROXY=1`, `SAVE_SECRET` and `PUBLIC_URL`. Add a volume and `DATA_DIR` for full persistence.

**Fly.io.** Run `fly launch`, keep one machine (`fly scale count 1`), and set `TRUST_PROXY=1`, `CLIENT_IP_HEADER=fly-client-ip`, `SAVE_SECRET` and `PUBLIC_URL`. Mount a volume and set `DATA_DIR` to it for full persistence.

**Your own server** behind nginx. Run the app under a process manager such as systemd or pm2, set `DATA_DIR` to a folder the app can write, and pass WebSocket upgrades through:

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

## Admin dashboard

A private dashboard at `/admin` shows how the game is being played. It is **off until you set it up**: without an admin account, `/admin` returns "Not found".

### Set up the Superadmin (once)

There is one account, and it is defined by three server environment variables. Nothing is created through the website.

1. On your own computer, in this folder, run:

   ```bash
   npm run admin:setup
   ```

   Choose a username, then type a password (at least 8 characters; it isn't shown or saved). The command prints three values: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (an scrypt hash, not the password), and `ADMIN_TOTP_SECRET`.
2. Add the one-time-code key it shows to an authenticator app (1Password, Google Authenticator, Authy, Aegis, Microsoft Authenticator). Type the app's current code when the command asks, to check it works.
3. Put the three values into the server's environment. On Render: the service's **Environment** tab, **Add Environment Variable**, then **Save** (this redeploys). Locally: a `.env` file. Treat all three as secrets. In a shell, wrap the hash in single quotes, because it contains `$`.
4. Open `https://<your-address>/admin` and sign in with the username, the password and the app's current code.

Keep the password in a password manager and back up the authenticator key. If either is lost, run the setup again and replace the variables; every existing admin session then stops working.

A one-time code is required unless you set `ADMIN_MFA=off`, which is not recommended; the server warns about it in its log.

### Database

Statistics history and admin sessions need a database. The server picks one at start-up, creates its tables and applies new migrations automatically (`server/migrations.js`; each is recorded in `schema_migrations`).

| Setting | Database | Survives restarts on Render's free plan |
|---------|----------|------------------------------------------|
| `DATABASE_URL=postgres://…` | PostgreSQL | Yes |
| `DATA_DIR` (no `DATABASE_URL`) | SQLite file `lastcall.db` in that folder | Only on a persistent disk (paid plans) |
| neither | memory | No: history resets on every restart, and the dashboard shows a warning |

Render's free web service has no disk, so for lasting history use PostgreSQL:
- **Render Postgres:** create one in the dashboard (**New > Postgres**), in the same region as the web service, and copy its **Internal Database URL** into `DATABASE_URL`. Check Render's current pricing first: free Render databases expire after a set period unless upgraded.
- **Another provider** (for example Neon or Supabase, both with free tiers): copy its connection string into `DATABASE_URL`, and add `?sslmode=require` if it doesn't already have it.

If the database can't be reached at start-up, the game still starts, keeps statistics in memory, and logs an error. The game itself never depends on the database.

**Backups.** Use your provider's backups for PostgreSQL. For SQLite, copy `lastcall.db` while the server is stopped.

### What the dashboard shows

**Live, from server memory** (resets when the server restarts): players connected now, rooms with someone in them, stages in progress, and the most players connected at once since the last restart.

**Stored history** (for today, the last 7 days and the last 30 days):
- **Stages:** started, completed, won, lost, abandoned, in progress, and the completion rate.
- **Sessions:** unique browser sessions, room sessions, average session duration, and the peak number of players connected at once.
- **Connections:** drops, drops per session, quick recoveries and reconnections.
- **Puzzles**, per machine: completion rate, average attempts, wrong answers and hints.
- **Activity:** a chart of stages started per day, a list of recently seen anonymous browser sessions, and older months as daily totals.

**Admin:** your signed-in sessions (revoke any of them, or sign out all the others) and the audit log.

How each number is counted:

| Metric | Definition |
|--------|------------|
| Players connected now | Seats with an open connection right now |
| Stage started | Either player started a stage; one attempt at a stage is one "game" |
| Won | All three puzzles solved |
| Lost | The stage countdown ran out |
| Abandoned | Ended without a result (back to the map, or the room closed), or no result 6 hours after starting |
| Completed | Won + lost |
| Completion rate | Won ÷ (won + lost + abandoned) |
| Browser session | One browser tab's session: a random id in `sessionStorage` that ends when the tab closes. **Not a person:** the same person on two devices, or after closing the tab, counts again |
| Room session | One browser session's time in one room, from first connecting to leaving or the room closing |
| Average session duration | Mean length of room sessions that ended in the range (sessions cut off by a restart are left out) |
| Drop / long drop | A connection closed without leaving; long drops lasted over 8 seconds |
| Quick recovery | A reconnection within 8 seconds of a drop |
| Peak concurrent players | The most players connected at once, per UTC day |
| Time ranges | "Today" starts at 00:00 UTC; 7 and 30 days are rolling windows ending now. Results count when they happen |

The dashboard repeats these under **How each number is counted**.

### Privacy and retention

- **Never stored:** chat, player names, room codes (they are invitations), seat tokens, answers, passwords, IP addresses.
- **Stored instead:** the room and the browser session appear only as keyed hashes (HMACs) made with a key derived from `SAVE_SECRET`.
- **Repeats are harmless.** Each event has an id, so writing it twice (for example after a failed write is retried) stores it once.
- **Retention:**
  - Raw events: 90 days (`ANALYTICS_RETENTION_DAYS`), then added up into daily totals and deleted.
  - Daily totals: 730 days (`ANALYTICS_ROLLUP_DAYS`).
  - Audit log: 365 days. Its network addresses are shortened to /24 (IPv4) or /48 (IPv6).
- **Players are told.** The start screen says anonymous statistics are kept. If you run the game where privacy laws apply, check whether you need more (this isn't legal advice).

### Sessions and the audit log

- **The session cookie** (`__Host-lc_admin`) is `Secure`, `HttpOnly` and `SameSite=Strict`, and only its hash is stored. Sign-in needs HTTPS, or `http://localhost` when testing.
- **Sessions end** after 30 idle minutes or 8 hours (`ADMIN_IDLE_MINUTES`, `ADMIN_SESSION_HOURS`), and the cookie is replaced every 15 minutes.
- **Sign out** with **Sign out**. Under **Admin sessions** you can revoke any session, or **Sign out all other sessions** if you signed in somewhere you no longer trust.
- **Sign-in attempts are limited** to 5 per network address and 30 overall every 15 minutes.
- **Every change is checked:** it needs a per-session CSRF token and a request from the dashboard's own page.
- **The audit log** lists sign-ins (and failed or blocked attempts), sign-outs, revocations and refused requests. It never contains passwords, codes or cookies.

## Search engines, copying and ownership

### Keeping the game out of Google

Every page carries `<meta name="robots" content="noindex">` and an `X-Robots-Tag: noindex` header, so search engines that read the page drop it from their results. `robots.txt` deliberately allows crawling: a crawler that is blocked never sees the `noindex` and can still list the bare address. WhatsApp and other link previews keep working, because they don't use search indexing.

`noindex` **reduces search visibility; it does not make the game private.** Anyone with the link can still play, and other sites can still link to it.

**To remove a result that Google already shows:**
1. Wait for Google to recrawl: once it sees `noindex`, the page drops out, usually within days to weeks.
2. To speed it up, verify the site in [Google Search Console](https://search.google.com/search-console): add a **URL prefix** property for your address, choose the **HTML tag** method, and copy the `content` value into the `GOOGLE_SITE_VERIFICATION` environment variable. The server then adds the tag, with no code change.
3. In Search Console, use **Removals > New request** to hide the address for about six months while `noindex` takes over permanently. Use **URL Inspection > Request indexing** to ask Google to recrawl now.
4. If you can't verify the site, Google's [Refresh Outdated Content](https://search.google.com/search-console/remove-outdated-content) tool lets anyone ask Google to recheck a page.

On Render's free plan, Render answers `robots.txt` itself with "disallow all" while the service is asleep. Google retries later, but checks can take a little longer.

### What can and can't be protected

- **The game's code is delivered to every player's browser, so it can be read and copied.** Minifying the files would only make them harder to read, not hidden. There is no build step and no source maps are published; keep production source maps off unless you set up private error monitoring.
- **Last Call does not try to block** right-click, copying, screenshots or developer tools. Those tricks are easy to get round and get in the way of keyboard and screen-reader users.
- **What actually protects the game** is that the answers and the other role's clues never reach the browser, and that every result is decided on the server.

### The source repository

The repository `shibinputhramannil/last-call` is currently **public**: anyone can browse and download the source on GitHub. Making it private would stop people browsing the server code, puzzle generators and tests, though the browser code would still reach every player.

If you make it private:
- Render keeps deploying as long as its GitHub connection still has access to the repository; check under the service's **Settings > Build & Deploy** afterwards.
- GitHub Actions minutes for private repositories are limited on free accounts.

The visibility has not been changed: that's the owner's decision.

### Copyright

© 2026 Sibin P. All rights reserved. The game, its story, artwork and code are not licensed for reuse (`"license": "UNLICENSED"` in `package.json`), and the start screen carries the notice. A notice states ownership; it doesn't technically stop copying.

## Sharing and link previews

Sending the game's address, or a room invite link (`…/?room=K7QM3X`), in WhatsApp, iMessage, Slack or social apps shows a preview with the Last Call poster, a title and a short description.

- The preview tags (`og:title`, `og:description`, `og:image` and its size and alt text, `og:url`, and Twitter card tags) are in the page's first HTML response, filled in by the server. Link-preview crawlers don't run JavaScript, so nothing depends on it.
- The poster is [`public/og/last-call-poster-v1.jpg`](public/og/last-call-poster-v1.jpg): 1200 × 630 JPEG, about 80 KB (WhatsApp tends to drop images over about 300 KB). Its address is absolute, built from `PUBLIC_URL`, or Render's `RENDER_EXTERNAL_URL`, or the request's own host.
- Invite links share the same poster and say which room you're invited to; opening one still opens that room's join screen.

**Check a preview** from a terminal (replace the address):

```bash
curl -s -A "WhatsApp/2.24" "https://last-call-vdui.onrender.com/?room=K7QM3X" | grep -E 'og:|twitter:'
curl -sI "https://last-call-vdui.onrender.com/og/last-call-poster-v1.jpg"   # expect 200 and image/jpeg
```

Or paste the address into a preview checker such as <https://www.opengraph.xyz> or Meta's Sharing Debugger (<https://developers.facebook.com/tools/debug/>).

**Changing the poster or the text.** Apps cache previews per address, often for days, and WhatsApp has no public refresh button.
1. Never overwrite the poster in place: save the new image under a new name (`last-call-poster-v2.jpg`) and update both image tags in `public/index.html`. The poster's source is [`tools/og-poster.html`](tools/og-poster.html); open it in a browser at 1200 × 630 and screenshot it as a JPEG.
2. Ask Meta's Sharing Debugger to **Scrape Again** for the game's address; WhatsApp usually follows within a day.
3. To see the new preview at once, share the address with something new on the end, such as `https://last-call-vdui.onrender.com/?v=2`. Room links are new addresses every time, so they always pick up the current preview.
4. On the free plan, a sleeping server can take about a minute to answer a crawler, which may time out and show no preview. Open the game yourself first to wake it.

## Environment variables

All are optional.
- **Locally:** copy `.env.example` to `.env`; the server reads it on start.
- **On a host:** set them in the dashboard.
- **Secrets:** never commit `.env`, an API key, `SAVE_SECRET`, `DATABASE_URL` or any `ADMIN_*` value. `.env` is git-ignored, and `.env.example` holds placeholders only.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port. Render and most hosts set this for you. |
| `HOST` | `0.0.0.0` | Bind address. |
| `TRUST_PROXY` | `false` | Set to `1` behind a reverse proxy or a platform like Render, Railway or Fly. Rate limits then see real client IPs (the last `X-Forwarded-For` entry), and HTTPS is detected. Leave it off when nothing sits in front of the server, or clients could spoof their IP. |
| `CLIENT_IP_HEADER` | none | With `TRUST_PROXY=1`: a header that holds the real client IP and that clients can't forge through your proxy. Use `cf-connecting-ip` on Render (which sits behind Cloudflare; `render.yaml` sets it) or `fly-client-ip` on Fly.io. Unset means the last `X-Forwarded-For` entry is used. |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL`, else the request's host | Public address for share previews, e.g. `https://last-call.example.com`. |
| `DATABASE_URL` | none | PostgreSQL for statistics and admin sessions. See [Database](#database). |
| `ANALYTICS_RETENTION_DAYS` | `90` | Days to keep raw statistics events before adding them up into daily totals. |
| `ANALYTICS_ROLLUP_DAYS` | `730` | Days to keep the daily totals. |
| `ADMIN_USERNAME` | none | The Superadmin's username. All three `ADMIN_*` values come from `npm run admin:setup`. |
| `ADMIN_PASSWORD_HASH` | none | The scrypt hash of the Superadmin's password (never the password itself). |
| `ADMIN_TOTP_SECRET` | none | The key for the Superadmin's one-time codes. |
| `ADMIN_MFA` | `required` | Set to `off` to allow sign-in without a code (not recommended). |
| `ADMIN_SESSION_HOURS` | `8` | Longest an admin session lasts. |
| `ADMIN_IDLE_MINUTES` | `30` | Admin sessions end after this long without use. |
| `GOOGLE_SITE_VERIFICATION` | none | Google Search Console's HTML-tag value, to verify the site. |
| `SAVE_SECRET` | random per start | Signs saved progress and room tickets kept by browsers. 16+ characters; keep it stable. See [Persistence](#persistence). |
| `DATA_DIR` | none | Folder for saved rooms, on a persistent disk. See [Persistence](#persistence). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `ALLOWED_ORIGINS` | none | Extra comma-separated origins allowed to open the game's WebSocket. The page's own origin is always allowed. |
| `ROOM_IDLE_MINUTES` | `30` | Close a room after this long with nobody connected. |
| `ROOM_MAX_HOURS` | `4` | Close every room after this long, regardless of activity. |
| `ENABLE_AI_NARRATOR` | `false` | Turn on the optional Claude narrator (also needs a key). |
| `ANTHROPIC_API_KEY` | none | Claude API key, used only by the server. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model the narrator uses. |

### Optional: the Claude narrator

After each restored stage and at the end of the campaign, "The Exchange" posts one short, eerie line in the chat. By default these lines come from a built-in set, and the game needs no API key.

To have Claude write them instead, set both `ENABLE_AI_NARRATOR=true` and `ANTHROPIC_API_KEY` on the server.

- **What's sent:** only the event (for example "completed the stage Lamp Test"). Never answers, clues, player names or chat.
- **Safeguards:** calls are capped at 30 per minute across the server. If a call fails, times out or is declined, the built-in line is used.
- **Model:** it runs on `claude-opus-5-5` at low effort, with the API's refusal fallback switched on. Set `ANTHROPIC_MODEL` to use a different model.

The key is read from the environment on the server and is never sent to browsers.

## Checks

```bash
npm run lint    # ESLint over server, client and tests
npm test        # node:test suites (below)
npm run check   # both
```

The PostgreSQL tests run when `TEST_DATABASE_URL` points at a **disposable** database (they wipe their own schemas). CI provides one. Locally, with Docker:

```bash
docker run -d --name lastcall-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=lastcall_test -p 127.0.0.1:15433:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15433/lastcall_test npm test
```

The tests cover:
- **Every one of the 200 stages,** each generated with several seeds: an independent solver works out the answer using only the Caller's and the Operator's views, and the server must accept it. Each role's view is checked for the other role's clues and for the answer.
- **The campaign's structure:** at least 200 stages, no two with the same mix of puzzles, difficulty rising chapter by chapter, and each finale the hardest stage of its chapter.
- **Each mechanic's rules,** case by case, and that every rule in a manual actually matters on its board.
- **Scoring and stars,** progress and unlocking, and that signed saves can't be forged.
- **The game:** stage runs, the fair clock, transitions, hints, countdowns, and saving and restoring a run mid-puzzle.
- **Rooms:** presence and the quiet grace period for drops, chat delivery and de-duplication, Continue and stage picks pressed by both players at once, simultaneous reconnects, and restarts with and without `DATA_DIR`.
- **The browser's connection layer,** in Node with a fake WebSocket: one socket at a time, close reasons that never leak between sockets, backoff, dead-socket detection, and no false alarms after a sleeping tab wakes.
- **Two real WebSocket clients** playing a whole stage, dropping and reconnecting, plus the share-preview tags, health check, graceful shutdown and rate limits.
- **The admin dashboard**, on SQLite and PostgreSQL:
  - Signed-out visitors and players get nothing from it.
  - Sign-in needs the password and a fresh one-time code, and is rate-limited.
  - Cookies carry the right flags; CSRF and origin checks hold.
  - Idle, expired, rotated and revoked sessions stop working.
  - The audit log never holds secrets.
- **Statistics,** on SQLite and PostgreSQL: counts at the exact edges of each time range, repeated and retried writes stored once, and old events rolled up and expired.
- **No private data** (room codes, tokens, names, chat or answers) reaches the admin pages, the database or public endpoints.
- **Message validation**, the failed-seat limit, ignored forwarded-IP headers, oversized messages, security headers and `noindex`.

There is no build step: the browser loads the files in `public/` and `shared/` as they are. GitHub Actions runs `npm run check` on every push to `main` and on pull requests ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## How it works

```
public/             Browser client (plain HTML, CSS and ES modules, no build step)
  index.html        The page; the server fills in its share-preview tags
  js/main.js        Screens, room flow, connection status, stage clock, hints
  js/net.js         Room API calls and the self-reconnecting WebSocket
  js/heartbeat-worker.js  Heartbeat ticks that keep going in background tabs
  js/chat.js        Chat panel: receipts, automatic re-sends, queued and saved messages
  js/story.js       The opening story
  js/map.js         The stage map
  js/result.js      Stage results, scores and stars
  js/caller.js      The Caller's machines
  js/manual.js      The Operator's field manual
  js/settings.js    The Settings panel
  js/audio.js       Procedural music and sound effects (Web Audio)
  og/               The share-preview poster
shared/             Code used by both sides
  campaign.js       Chapters, mechanics, and the 200-stage campaign (versioned format)
  story.js          The opening, chapter texts, and every stage's title and story beat
  scoring.js        How scores and stars are worked out
  art.js            Glyph, stamp, cap and cadence artwork (pictures only, never meanings)
  constants.js      Room-code rules and limits
server/
  index.js          Entry point: start-up checks, logging, graceful shutdown
  app.js            HTTP API, the page with share tags, health check, WebSocket, rate limits
  rooms.js          Rooms, seats, presence, reconnection, chat, restarts, expiry
  game.js           A stage run: puzzles, the fair clock, answers, hints, results
  progress.js       A team's campaign progress
  signing.js        Signed saves and room tickets
  store.js          Room persistence (DATA_DIR) and the signing secret
  puzzles/          One module per mechanic: levels, generation, role views, answer check, hints
  narrator.js       Optional Claude-written atmosphere lines
  validate.js       Shape checks for every WebSocket message
  admin.js          The /admin dashboard: sign-in, sessions, CSRF, audit, data APIs
  auth.js           Password hashing (scrypt) and one-time codes (TOTP)
  analytics.js      Anonymous statistics: events, metrics, roll-ups and retention
  db.js             One SQL layer over PostgreSQL and SQLite
  migrations.js     The database schema, versioned
admin/              The dashboard's pages (served only by server/admin.js)
scripts/admin-setup.js  Makes the Superadmin's environment values
docs/SECURITY.md    Security notes and threat model
tools/og-poster.html  Source of the share poster
test/               Node test runner suites
render.yaml         Render Blueprint (one web service)
```

**The server is the authority.** It generates each puzzle, keeps the answers, and sends each player a view built only for their role. The Caller's browser never receives the manual, and the Operator's browser never receives the machine data. Neither receives an answer. Each mechanic defines its views, answer check and hints together, so the clues, the validation and the hints can't drift apart.

**Campaign data.** `shared/campaign.js` holds an authored plan for each chapter: which mechanics appear and at which levels. The twenty stages of each chapter are derived from that plan deterministically: they follow a rising difficulty curve, never repeat a combination used anywhere in the campaign, and save the chapter's hardest stage for its finale. Each stage's title and story beat are written by hand in `shared/story.js`. Stage data is versioned (`STAGE_FORMAT`, `CAMPAIGN_VERSION`); to add a chapter, add its story and plan, and to add a mechanic, add it to `MECHANICS`, a module in `server/puzzles/` and a renderer for each role. `validateCampaign()` runs in the tests.

**Rooms and seats.**
- **Room codes** are 6 random characters from an alphabet without look-alikes (no I, L, O, 0 or 1).
- **Seat tokens.** Joining gives your browser a random 128-bit seat token. It's kept in `localStorage`, so a reload or a dropped connection puts you straight back in your seat.
- **Room tickets.** The server also gives each seat a signed ticket (room code, role, and a fingerprint of the seat token, never the token itself). After a restart without saved rooms, the first player to reconnect rebuilds the room from their ticket, and their partner's ticket puts them back in the other seat.
- **Taking over a seat.** If a player has been gone for more than 20 seconds, someone joining with the code can take their seat.
- **Another tab.** Opening the same seat in a second tab moves the connection there, and the first tab says so.

**Detecting dead connections.**
- **The browser** sends an app-level ping every 15 seconds, timed by a Web Worker so it keeps going in background tabs. If a ping gets no reply within 10 seconds, it drops the connection and reconnects. If the page was asleep (a frozen or throttled tab), it re-tests the line with a fresh ping instead of declaring it dead.
- **The browser keeps one socket at a time.** A retry never opens a second socket while one is connecting or saying hello, and each socket's close reason belongs to that socket alone. (Both of these used to cause repeated "connection lost" messages.)
- **The server** drops a connection after 70 seconds without any message. It doesn't rely on WebSocket ping frames alone, because some hosting proxies (including Render's) answer those themselves even after the player has gone.
- **Presence.** A drop pauses the stage clock at once, but is announced to the partner only after 8 seconds.

**Consistency.** The server handles one message at a time. Stage starts, Continue and Back to the map name the run or result they refer to, so when both players press at once the first press wins and the second does nothing. State updates carry a revision number, and every reconnect starts from a full snapshot.

**Expiry.**
- A room closes after `ROOM_IDLE_MINUTES` with nobody connected, and in any case after `ROOM_MAX_HOURS`.
- For 12 hours afterwards, the code is remembered as "closed", so players see why the room is gone rather than "no such room".

**Limits and hardening.**
- **Rate limits:**
  - room creation: 8 per IP every 10 minutes
  - code lookups and joins: 40 per IP every 5 minutes
  - WebSocket connections: 30 per IP per minute, at most 12 open at once
  - failed seat attempts (wrong token or room): 20 per IP every 10 minutes
  - admin sign-in: 5 per IP and 30 overall every 15 minutes
  - messages per socket, chat per player, answers (2.5 s apart) and hints (30 s apart) are throttled too
- **Validation:** every WebSocket message is checked against its type's allowed fields, types and lengths before the game sees it.
- **Message sizes:** WebSocket messages are capped at 16 KB, request bodies at 16 KB, chat messages at 400 characters, and names at 20.
- **Input cleaning:** control and bidi-override characters are stripped. Chat is always rendered as text, never HTML. Room codes in share tags are validated and escaped.
- **Headers:** responses carry a strict Content-Security-Policy (no inline scripts or styles), `Referrer-Policy: no-referrer` (so room codes in URLs never leak), `X-Frame-Options: DENY` and `nosniff`. WebSocket connections from other sites are refused.

## Known limitations

- One instance only: a second server process would not see the first one's rooms.
- Without `DATA_DIR`, a restart keeps progress, rooms and seats, but a stage in progress starts again with new puzzles, and the chat history is lost.
- There's no built-in voice chat. Players who want to talk can use a phone or voice call alongside the in-game chat.
- One seat per browser profile per room. Use a second browser or a private window to play both roles on one machine.
