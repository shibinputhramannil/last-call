// Last Call admin dashboard. Everything shown comes from authenticated
// /admin/api/* calls; the server decides what may be read. Text is always set
// with textContent, never parsed as HTML.

const SVG = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
let csrf = null;
let overview = null;
let range = 'week';

function el(tag, attrs = {}, ...children) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const clear = (node) => {
  while (node.firstChild) node.firstChild.remove();
  return node;
};

// ---- Formatting ---------------------------------------------------------------

const num = (n) => (n == null ? '–' : Number(n).toLocaleString());
const pct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);
const dec = (n) => (n == null ? '–' : n.toFixed(1));
function duration(ms) {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
const when = (ts) => el('time', { datetime: new Date(ts).toISOString(), title: new Date(ts).toUTCString() }, ago(ts));
const MECHANIC = {
  'dead-line': 'The Dead Line',
  'patch-bay': 'The Patch Bay',
  teleprinter: 'The Teleprinter',
  'party-line': 'The Party Line',
  'relay-rack': 'The Relay Rack',
  'cipher-wheel': 'The Cipher Wheel',
};
const EVENT = {
  'session.joined': 'Joined a room',
  'session.reconnected': 'Reconnected',
  'session.dropped': 'Connection dropped',
  'session.drop_long': 'Dropped for a while',
  'session.ended': 'Left',
  'stage.started': 'Started a stage',
  'stage.won': 'Won a stage',
  'stage.lost': 'Lost a stage',
  'stage.abandoned': 'Abandoned a stage',
  'puzzle.solved': 'Solved a puzzle',
  'answer.wrong': 'Wrong answer',
  'hint.read': 'Read a hint',
};

// ---- Requests -----------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/admin');
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Request failed (${res.status})`);
  return res.json();
}

// ---- Rendering ----------------------------------------------------------------

function kpi(label, value, note) {
  return el('div', { class: 'kpi' }, el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value), note ? el('div', { class: 'kpi-note' }, note) : null);
}

function renderLive() {
  const live = overview.live;
  $('live-players').textContent = num(live.players);
  $('live-time').textContent = `Measured ${new Date(live.measuredAt).toLocaleTimeString()}. Refreshes every 15 seconds.`;
  const today = overview.metrics.ranges.today;
  clear($('live-kpis')).append(
    kpi('Active rooms now', num(live.activeRooms), `${num(live.openRooms)} open, including rooms waiting for players`),
    kpi('Stages in progress now', num(live.stagesInProgress)),
    kpi('Peak since the last restart', num(live.peakSinceStart), live.peakAt ? `at ${new Date(live.peakAt).toLocaleTimeString()}` : 'no players yet'),
    kpi('Peak today (UTC)', num(Math.max(today.peak.players, live.players)), 'stored history plus now'),
    kpi('Server up since', new Date(live.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 'live numbers start again after a restart'),
  );
}

function renderRange() {
  const r = overview.metrics.ranges[range];
  for (const b of document.querySelectorAll('#range button')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
  const label = { today: 'today (from 00:00 UTC)', week: 'the last 7 days', month: 'the last 30 days' }[range];
  $('range-note').textContent = `Showing ${label}.`;
  const g = r.games;
  clear($('game-kpis')).append(
    kpi('Started', num(g.started)),
    kpi('Completed', num(g.completed), 'won plus lost'),
    kpi('Won', num(g.won)),
    kpi('Lost', num(g.lost), 'countdown ran out'),
    kpi('Abandoned', num(g.abandoned)),
    kpi('Completion rate', pct(g.completionRate), 'won ÷ finished'),
    kpi('In progress', num(g.inProgress), 'started under 6 hours ago'),
  );
  const s = r.sessions;
  clear($('session-kpis')).append(
    kpi('Unique browser sessions', num(s.unique), 'one per browser tab session, not per person'),
    kpi('Room sessions joined', num(s.joined)),
    kpi('Average session duration', duration(s.avgDurationMs), `over ${num(s.ended)} ended sessions`),
    kpi('Peak concurrent players', num(r.peak.players), 'highest daily peak in range'),
  );
  const c = r.connection;
  clear($('connection-kpis')).append(
    kpi('Drops', num(c.drops), `${num(c.longDrops)} lasted over 8 s`),
    kpi('Drops per room session', dec(c.dropsPerSession)),
    kpi('Quick recoveries', pct(c.quickRecoveryRate), 'back within 8 s'),
    kpi('Reconnections', num(c.reconnects)),
  );
  renderPuzzles(r);
}

function renderPuzzles(r) {
  $('puzzles-range').textContent = `Same time range as above. ${r.puzzles.length ? '' : 'No puzzles yet in this range.'}`;
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      el('th', { scope: 'col' }, 'Machine'),
      ['Shown', 'Solved', 'Completion', 'Avg attempts', 'Wrong per puzzle', 'Hints per puzzle'].map((h) => el('th', { scope: 'col', class: 'num' }, h)),
    ),
  );
  const rows = r.puzzles.map((p) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row' }, MECHANIC[p.type] || p.type),
      el('td', { class: 'num' }, num(p.shown)),
      el('td', { class: 'num' }, num(p.solved)),
      el('td', { class: 'num' }, pct(p.completionRate)),
      el('td', { class: 'num' }, dec(p.avgAttempts)),
      el('td', { class: 'num' }, dec(p.wrongPerPuzzle)),
      el('td', { class: 'num' }, dec(p.hintsPerPuzzle)),
    ),
  );
  clear($('puzzles-table')).append(el('caption', { class: 'sr-only' }, 'Puzzle completion, wrong answers and hints by machine'), head, el('tbody', {}, rows));
}

/** One series (stages started), thin bars from one baseline, a tooltip on hover or focus, and a table view. */
function renderDaily() {
  const days = overview.metrics.daily;
  const box = clear($('daily-chart'));
  const width = Math.max(320, box.clientWidth || 640);
  const height = 192;
  const pad = { top: 10, right: 8, bottom: 22, left: 34 };
  const max = Math.max(1, ...days.map((d) => d.started));
  const stepSize = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((s) => max / s <= 4) || Math.ceil(max / 4);
  const top = Math.ceil(max / stepSize) * stepSize;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / days.length;
  const barW = Math.min(24, Math.max(3, slot - 2));
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const svg = el('svg:svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Stages started per day for the last 30 days. The same numbers are in the table below.' });
  const grid = el('svg:g', { class: 'grid' });
  for (let v = 0; v <= top; v += stepSize) {
    grid.append(el('svg:line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }), el('svg:text', { class: 'tick', x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, num(v)));
  }
  svg.append(grid);
  const tip = el('div', { class: 'tooltip', hidden: true });
  days.forEach((d, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    const h = Math.max(0, (d.started / top) * plotH);
    const label = `${d.day}: ${d.started} started, ${d.won} won, ${d.lost} lost, ${d.abandoned} abandoned, ${d.sessions} browser sessions`;
    const hit = el('svg:rect', { class: 'hit', x: pad.left + i * slot, y: pad.top, width: slot, height: plotH, tabindex: 0, 'aria-label': label });
    const r = Math.min(4, barW / 2, h);
    const base = pad.top + plotH;
    // Rounded at the data end, square at the baseline.
    const bar = el('svg:path', {
      class: 'bar',
      d: h > 0 ? `M${x} ${base}V${base - h + r}Q${x} ${base - h} ${x + r} ${base - h}H${x + barW - r}Q${x + barW} ${base - h} ${x + barW} ${base - h + r}V${base}Z` : '',
    });
    const show = () => {
      clear(tip).append(el('strong', {}, num(d.started)), ' started', el('br'), `${d.day} · ${d.won} won · ${d.sessions} sessions`);
      tip.hidden = false;
      const left = Math.min(width - 180, Math.max(0, x - 60));
      tip.style.setProperty('left', `${left}px`);
      tip.style.setProperty('top', `${Math.max(0, base - h - 52)}px`);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => (tip.hidden = true));
    hit.addEventListener('blur', () => (tip.hidden = true));
    svg.append(hit, bar);
    // A label every week, and on the last day unless it would crowd the one before.
    if (i % 7 === 0 || (i === days.length - 1 && i % 7 > 2)) {
      svg.append(el('svg:text', { class: 'tick', x: pad.left + i * slot + slot / 2, y: height - 6, 'text-anchor': 'middle' }, d.day.slice(5)));
    }
  });
  box.append(svg, tip);

  clear($('daily-table')).append(
    el('caption', {}, 'Per day, UTC'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Day'), ['Started', 'Won', 'Lost', 'Abandoned', 'Browser sessions'].map((h) => el('th', { scope: 'col', class: 'num' }, h)))),
    el(
      'tbody',
      {},
      [...days].reverse().map((d) =>
        el('tr', {}, el('th', { scope: 'row' }, d.day), [d.started, d.won, d.lost, d.abandoned, d.sessions].map((v) => el('td', { class: 'num' }, num(v)))),
      ),
    ),
  );
}

function renderMonths() {
  const months = overview.metrics.history;
  $('months-panel').hidden = months.length === 0;
  $('months-note').textContent = `Events older than ${overview.storage.retentionDays} days are kept only as daily totals, for ${overview.storage.rollupDays} days.`;
  clear($('months-table')).append(
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Month'), ['Started', 'Won', 'Lost', 'Abandoned', 'Room sessions'].map((h) => el('th', { scope: 'col', class: 'num' }, h)))),
    el(
      'tbody',
      {},
      months.map((m) => el('tr', {}, el('th', { scope: 'row' }, m.month), [m.started, m.won, m.lost, m.abandoned, m.sessionsJoined].map((v) => el('td', { class: 'num' }, num(v))))),
    ),
  );
}

function renderStorage() {
  const s = overview.storage;
  $('storage-source').textContent = `Stored history: ${s.label}`;
  $('def-retention').textContent = `Each event is stored once, even if it is written twice. Events are kept for ${s.retentionDays} days, then added up into daily totals (kept for ${s.rollupDays} days) and deleted. Admin audit entries are kept for 365 days.`;
  $('storage-warning').hidden = s.persistent;
  $('storage-warning-text').textContent =
    ' Statistics are held in memory and are lost when the server restarts. Set DATABASE_URL (PostgreSQL) or DATA_DIR on a persistent disk to keep them; see the README.';
}

async function loadActivity() {
  const { sessions } = await api('/admin/api/activity');
  const table = clear($('activity-table'));
  if (!sessions.length) {
    table.append(el('tbody', {}, el('tr', {}, el('td', { class: 'empty' }, 'No activity in the last 30 days.'))));
    return;
  }
  table.append(
    el('caption', { class: 'sr-only' }, 'Most recently seen anonymous browser sessions'),
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ['Browser session', 'Status', 'Last seen', 'First seen', 'Last event', 'Role', 'Stage'].map((h) => el('th', { scope: 'col' }, h)),
        el('th', { scope: 'col', class: 'num' }, 'Rooms'),
      ),
    ),
    el(
      'tbody',
      {},
      sessions.map((s) =>
        el(
          'tr',
          {},
          el('td', { class: 'mono' }, `b·${s.id.slice(0, 10)}`),
          el('td', {}, el('span', { class: `status${s.online ? ' is-online' : ''}` }, s.online ? 'Online now' : 'Offline')),
          el('td', {}, when(s.lastSeen)),
          el('td', {}, when(s.firstSeen)),
          el('td', {}, EVENT[s.lastEvent] || s.lastEvent || '–'),
          el('td', {}, s.role ? s.role[0].toUpperCase() + s.role.slice(1) : '–'),
          el('td', {}, s.stage || '–'),
          el('td', { class: 'num' }, num(s.rooms)),
        ),
      ),
    ),
  );
}

async function loadAdminSessions() {
  const { sessions } = await api('/admin/api/admin-sessions');
  clear($('admin-sessions-table')).append(
    el('thead', {}, el('tr', {}, ['Signed in', 'Last active', 'Network', 'Browser', ''].map((h) => el('th', { scope: 'col' }, h)))),
    el(
      'tbody',
      {},
      sessions.map((s) => {
        const revoke = el('button', { class: 'btn btn-danger', type: 'button' }, s.current ? 'Sign out' : 'Revoke');
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          const r = await api('/admin/api/admin-sessions/revoke', { method: 'POST', body: { handle: s.handle } }).catch(() => null);
          if (r?.self) location.replace('/admin');
          else await Promise.all([loadAdminSessions(), loadAudit()]);
        });
        return el(
          'tr',
          {},
          el('td', {}, when(s.createdAt), s.current ? ' (this browser)' : ''),
          el('td', {}, when(s.lastSeen)),
          el('td', { class: 'mono' }, s.network || '–'),
          el('td', {}, (s.browser || '').slice(0, 60) || '–'),
          el('td', {}, revoke),
        );
      }),
    ),
  );
}

async function loadAudit() {
  const { entries } = await api('/admin/api/audit');
  clear($('audit-table')).append(
    el('thead', {}, el('tr', {}, ['When', 'Action', 'Outcome', 'Network'].map((h) => el('th', { scope: 'col' }, h)))),
    el(
      'tbody',
      {},
      entries.length
        ? entries.map((e) =>
            el(
              'tr',
              {},
              el('td', {}, when(e.at)),
              el('td', {}, e.action),
              el('td', { class: `outcome-${e.outcome}` }, e.outcome.replace(/_/g, ' ')),
              el('td', { class: 'mono' }, e.network || '–'),
            ),
          )
        : el('tr', {}, el('td', { class: 'empty' }, 'No entries yet.')),
    ),
  );
}

async function loadOverview() {
  overview = await api('/admin/api/overview');
  renderStorage();
  renderLive();
  renderRange();
  renderDaily();
  renderMonths();
}

async function loadAll() {
  await Promise.all([loadOverview(), loadActivity(), loadAdminSessions(), loadAudit()]);
}

// ---- Start ----------------------------------------------------------------------

const session = await api('/admin/api/session');
csrf = session.csrf;
$('who').textContent = `Signed in as ${session.username}. Session ends by ${new Date(session.expiresAt).toLocaleTimeString()}, or after ${session.idleMinutes} idle minutes.`;
for (const b of document.querySelectorAll('#range button')) {
  b.addEventListener('click', () => {
    range = b.dataset.range;
    renderRange();
  });
}
$('refresh').addEventListener('click', () => loadAll());
$('signout').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST', body: {} }).catch(() => null);
  location.replace('/admin');
});
$('revoke-others').addEventListener('click', async () => {
  await api('/admin/api/admin-sessions/revoke-others', { method: 'POST', body: {} });
  await Promise.all([loadAdminSessions(), loadAudit()]);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => overview && renderDaily(), 150);
});
await loadAll();
setInterval(() => document.visibilityState === 'visible' && loadOverview().catch(() => {}), 15_000);
