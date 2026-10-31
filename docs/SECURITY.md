# Last Call: security notes and threat model

This describes what Last Call protects, from whom, how, and where the limits are. No site is unhackable; the aim is that the likely attacks are blocked or made expensive, and that a mistake or a leak exposes as little as possible.

## What there is to protect

| Asset | Where it lives | Why it matters |
|-------|----------------|----------------|
| Puzzle answers and each role's private clues | Server memory (and `DATA_DIR` room files) | Leaking them breaks the game's core idea |
| Seat tokens and room tickets | Players' `localStorage`; the server keeps tokens, tickets are signed | A stolen token lets someone take over a seat |
| Room codes | Invite links, players' browsers | They are invitations: anyone with one can try to join |
| Campaign progress | Signed tokens in browsers; the room on the server | Forged progress would unlock stages unearned |
| Chat | Server memory and `DATA_DIR` room files only (never the statistics database) | Private conversation between two players |
| Admin account and sessions | Server environment variables; hashed session ids in the database | Full view of the statistics |
| Statistics history | The database (`DATABASE_URL`, SQLite in `DATA_DIR`, or memory) | Anonymous, but still about players' behaviour |
| Server secrets (`SAVE_SECRET`, `DATABASE_URL`, `ADMIN_*`, `ANTHROPIC_API_KEY`) | Host environment only | Each one unlocks something above |

## Who might attack, and how

- **A curious player** opens developer tools, reads network traffic, edits messages or local storage to see the other role's clues, skip puzzles, forge progress or win without solving.
- **A stranger with a room link** (forwarded, posted publicly) tries to join, take a seat, or spam the chat.
- **An internet scanner** probes for admin pages, known paths, weak passwords and injection points, or floods the server.
- **A cross-site attacker** lures a signed-in admin to a page that sends requests to `/admin`, or frames the site.
- **Someone who gets a copy of the database or logs** (a leaked backup, a misconfigured host) looks for personal data or secrets.
- **Someone copying the game** downloads the HTML, CSS and JavaScript.

## Controls

**The server is the authority.** Puzzles are generated and checked on the server. Each browser receives only its own role's view; answers never leave the server, and the tests check every one of the 200 stages for leaks. Scores, stars, unlocking and stage outcomes are decided on the server. Editing the browser's code or messages can change what that browser shows, not the game.

**Input is checked.**
- Every WebSocket message is reduced to the fields its type allows, with types and lengths checked (`server/validate.js`). Unknown or malformed messages are refused.
- Messages and request bodies are capped at 16 KB. Chat is limited to 400 characters and names to 20. Control and bidirectional-override characters are stripped.
- Chat is always rendered as text, never as HTML.

**Rate limits.**
- Room creation: 8 per IP every 10 minutes.
- Code lookups and joins: 40 per IP every 5 minutes.
- WebSocket connections: 30 per IP per minute, and at most 12 open at once.
- Failed seat attempts (a wrong token or room): 20 per IP every 10 minutes.
- In a room: per-socket message flood control, chat per player, and cooldowns between answers (2.5 s) and between hints (30 s).
- Admin sign-in: 5 attempts per IP and 30 overall every 15 minutes.

**Client addresses.** Forwarded-IP headers are ignored unless `TRUST_PROXY=1`. With it, the server uses the header named in `CLIENT_IP_HEADER` (Cloudflare's `CF-Connecting-IP` on Render), else the last `X-Forwarded-For` entry, which is the one the host's own proxy added. A client cannot pick its own rate-limit key.

**Tokens and signatures.**
- Seat tokens are 128-bit random values, compared in constant time.
- Progress and room tickets are HMAC-signed with `SAVE_SECRET`. A ticket holds only a fingerprint of its seat token.
- A join id (random, made by the browser tab so a retried join gets the same seat back) is kept by the server only as a fingerprint, is honoured for 10 minutes, and is never sent back or logged. It can only return the seat it created.
- Messages from a socket that no longer holds its seat (replaced by another tab, or left) are ignored.

**Browser protections.**
- A strict Content-Security-Policy: scripts and styles from the site only (plus Google Fonts styles for the game), no inline code, no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
- `nosniff`, `Referrer-Policy: no-referrer` (room codes in URLs never leak to other sites), `Cross-Origin-Opener-Policy`, a restrictive `Permissions-Policy`, and HSTS over HTTPS.
- WebSockets from other sites' pages are refused (an origin check).
- No source maps are published.

**Errors and logs.**
- Errors return short, generic messages; stack traces go only to the server log.
- Logs never contain chat, player names, seat tokens, passwords, one-time codes, session cookies or secrets. A `DATABASE_URL` is never printed.

**The public health check** (`/healthz`) says only `ok` or `draining`. Player counts and history are only in the admin dashboard.

### The admin dashboard

- **One account, provisioned on the server.** `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (scrypt, N = 2^15) and `ADMIN_TOTP_SECRET` are environment variables, made with `npm run admin:setup`. There is no sign-up, default password, recovery link or other way in. Without all three, `/admin` returns 404.
- **Two factors.** A time-based one-time code (TOTP, RFC 6238) is required by default, and each code works once. Turning it off needs `ADMIN_MFA=off`, and the server warns about it at start-up.
- **Sign-in leaks nothing.** A wrong username, password or code all get the same answer, at a similar speed (a wrong username still runs the password check).
- **Sessions.**
  - A random 256-bit id in a `__Host-lc_admin` cookie: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no domain. Only its SHA-256 hash is stored.
  - Sessions end after 30 idle minutes and 8 hours at most. The cookie is replaced every 15 minutes, and the old one expires 30 seconds later.
  - Admins can list sessions, revoke any of them, or sign out every other session.
- **Changes need proof of origin.** Every state-changing request needs the session's CSRF token in a header and an `Origin` (or `Sec-Fetch-Site`) from this site. Sign-in needs the same origin check.
- **Every route is checked on the server**, including the dashboard's own script. Signed-out requests get the sign-in page or a 401, never data.
- **An audit log** records sign-ins (succeeded, failed, rate-limited), sign-outs, revocations and refused requests, with the time, the action, the outcome and a shortened network address. It is kept for 365 days.
- **Admin pages** are `no-store`, `noindex` and load nothing from third parties.

### Statistics and privacy

- **What is stored:**
  - event types (stage started or won, a puzzle solved, a hint read, a connection dropped), times, stage ids, puzzle types and levels, and roles;
  - keyed hashes standing in for the room and for the browser session.
- **What is never stored:** chat, names, room codes, seat tokens, answers or IP addresses. The browser-session id is a random value in the tab's `sessionStorage`, which ends when the tab is closed, so it cannot follow a person across visits.
- **Retention:**
  - Raw events are kept for 90 days (`ANALYTICS_RETENTION_DAYS`), then added up into daily totals and deleted.
  - Daily totals are kept for 730 days (`ANALYTICS_ROLLUP_DAYS`).
  - The audit log is kept for 365 days.
- The game's start screen tells players that anonymous statistics are kept. If you run Last Call where privacy rules apply (for example the GDPR or ePrivacy rules), check whether you need a fuller notice or consent; this is not legal advice.

## Known limits and residual risks

- **Anyone with a room link can join while a seat is free**, and can take over a seat left empty for 20 seconds. Room codes are invitations, not passwords. Treat a shared link like a meeting link.
- **The client code is public.** Browsers must download HTML, CSS and JavaScript to run the game, so anyone can read and copy it. Minifying would only make it harder to read, not secret. Right-click blocking, devtools detection and screenshot prevention don't work reliably and harm accessibility, so Last Call doesn't use them. The puzzles stay fair because answers and the other role's clues never reach the browser.
- **`noindex` is a request to search engines**, not access control. Anyone with the address can still open the game.
- **Admin passwords can be as short as 8 characters.** Online guessing is held back by the one-time code and the sign-in limits, but if the hash ever leaked, a short or predictable password could be cracked offline despite scrypt. Use a random password from a password manager, and longer is better.
- **One admin account** means the account is a single point of failure. Store the password in a password manager, and keep the authenticator secret backed up (an authenticator app with encrypted backup, or a printed recovery copy kept safely). Losing it means generating new values with `npm run admin:setup`.
- **The admin dashboard is reachable from the internet.** It is protected by a password, a one-time code and rate limits, but not by a network allow-list. If your host offers IP allow-listing or an access proxy (for example Cloudflare Access), putting `/admin` behind it adds another layer.
- **Rate limits are per server process and in memory.** They reset on restart and assume one instance (which the game needs anyway).
- **Denial of service.** The limits above slow abuse, but a large attack needs protection at the host or CDN (Render runs behind Cloudflare).
- **The statistics database holds pseudonymous data.** Keys are HMACs with a server secret, so they can't be reversed without it, but an attacker holding both the database and `SAVE_SECRET` could link events to a browser that still has its session id.
- **Dependencies.** `npm audit --omit=dev` reports no known vulnerabilities in what the server runs. Development tools (ESLint) currently carry a moderate advisory in `minimatch` that does not affect the running game; update them when a fixed release is available.

## Reporting a problem

Please report security issues privately to the repository owner rather than in a public issue.
