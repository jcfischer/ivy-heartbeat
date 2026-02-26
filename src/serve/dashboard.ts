/**
 * Generate the HTML dashboard page.
 * Self-contained — no external dependencies. Uses inline CSS and vanilla JS.
 */
export function generateDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ivy Heartbeat Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
  h1 { color: #4fc3f7; margin-bottom: 8px; font-size: 1.4em; }
  h2 { color: #81d4fa; margin: 16px 0 8px; font-size: 1.1em; border-bottom: 1px solid #1a1a2e; padding-bottom: 4px; }
  .stats { display: flex; gap: 16px; margin: 12px 0; flex-wrap: wrap; }
  .stat { background: #1a1a2e; padding: 12px 16px; border-radius: 6px; min-width: 140px; }
  .stat-value { font-size: 1.5em; color: #4fc3f7; font-weight: bold; }
  .stat-label { font-size: 0.8em; color: #888; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 0.85em; }
  th { text-align: left; padding: 6px 8px; background: #1a1a2e; color: #81d4fa; font-weight: 600; }
  td { padding: 6px 8px; border-bottom: 1px solid #1a1a2e; }
  tr:hover td { background: #1a1a2e; }
  .ok { color: #4caf50; } .alert { color: #ff9800; } .error { color: #f44336; }
  .search-box { margin: 12px 0; display: flex; gap: 8px; }
  .search-box input { flex: 1; padding: 8px 12px; background: #1a1a2e; border: 1px solid #333; color: #e0e0e0; border-radius: 4px; font-family: inherit; }
  .search-box button { padding: 8px 16px; background: #1a237e; color: #81d4fa; border: none; border-radius: 4px; cursor: pointer; }
  .search-box button:hover { background: #283593; }
  #search-results { margin-top: 8px; }
  .refresh-note { color: #555; font-size: 0.75em; margin-top: 16px; }
</style>
</head>
<body>
<h1>Ivy Heartbeat Dashboard</h1>
<div id="summary"></div>

<h2>SpecFlow Pipeline</h2>
<div id="specflow-pipeline"><p style="color:#555;font-style:italic">Loading...</p></div>

<h2>Search Events</h2>
<div class="search-box">
  <input type="text" id="search-input" placeholder="Search events..." onkeyup="if(event.key==='Enter')doSearch()">
  <button onclick="doSearch()">Search</button>
</div>
<div id="search-results"></div>

<h2>Recent Events</h2>
<div id="events"></div>

<h2>Recent Heartbeats</h2>
<div id="heartbeats"></div>

<p class="refresh-note">Auto-refreshes every 30 seconds. <a href="#" onclick="refresh();return false" style="color:#4fc3f7">Refresh now</a></p>

<script>
async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

function relTime(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d/60) + 'm ago';
  if (d < 86400) return Math.round(d/3600) + 'h ago';
  return Math.round(d/86400) + 'd ago';
}

function statusClass(s) { return s === 'ok' ? 'ok' : s === 'alert' ? 'alert' : s === 'error' ? 'error' : ''; }

async function loadSummary() {
  const s = await fetchJSON('/api/summary');
  document.getElementById('summary').innerHTML = \`
    <div class="stats">
      <div class="stat"><div class="stat-value">\${s.totalEvents}</div><div class="stat-label">Events</div></div>
      <div class="stat"><div class="stat-value">\${s.activeAgents}</div><div class="stat-label">Agents</div></div>
      <div class="stat"><div class="stat-value">\${s.lastHeartbeat ? relTime(s.lastHeartbeat) : 'never'}</div><div class="stat-label">Last Heartbeat</div></div>
      <div class="stat"><div class="stat-value">\${s.recentChecks.length}</div><div class="stat-label">Checks</div></div>
    </div>
    \${s.recentChecks.length ? '<table><tr><th>Check</th><th>Status</th><th>Time</th></tr>' + s.recentChecks.map(c => \`<tr><td>\${c.name}</td><td class="\${statusClass(c.status)}">\${c.status}</td><td>\${relTime(c.time)}</td></tr>\`).join('') + '</table>' : ''}
  \`;
}

async function loadEvents() {
  const events = await fetchJSON('/api/events?limit=30');
  if (!events.length) { document.getElementById('events').innerHTML = '<p>No events.</p>'; return; }
  document.getElementById('events').innerHTML = '<table><tr><th>Time</th><th>Type</th><th>Summary</th></tr>' +
    events.map(e => \`<tr><td>\${relTime(e.timestamp)}</td><td>\${e.event_type}</td><td>\${e.summary.slice(0,80)}</td></tr>\`).join('') + '</table>';
}

async function loadHeartbeats() {
  const hbs = await fetchJSON('/api/heartbeats?limit=20');
  if (!hbs.length) { document.getElementById('heartbeats').innerHTML = '<p>No heartbeats.</p>'; return; }
  document.getElementById('heartbeats').innerHTML = '<table><tr><th>Time</th><th>Session</th><th>Progress</th></tr>' +
    hbs.map(h => \`<tr><td>\${relTime(h.timestamp)}</td><td>\${(h.session_id||'').slice(0,12)}</td><td>\${(h.progress||'-').slice(0,60)}</td></tr>\`).join('') + '</table>';
}

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  const results = await fetchJSON('/api/search?q=' + encodeURIComponent(q));
  if (!results.length) { document.getElementById('search-results').innerHTML = '<p>No results.</p>'; return; }
  document.getElementById('search-results').innerHTML = '<table><tr><th>Rank</th><th>Time</th><th>Summary</th></tr>' +
    results.map(r => \`<tr><td>\${r.rank.toFixed(2)}</td><td>\${relTime(r.event.timestamp)}</td><td>\${r.event.summary.slice(0,80)}</td></tr>\`).join('') + '</table>';
}

async function loadSpecFlow() {
  try {
    const res = await fetch('/api/specflow/panel');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    document.getElementById('specflow-pipeline').innerHTML = html;
  } catch(e) {
    document.getElementById('specflow-pipeline').innerHTML =
      '<p style="color:#f44336">Unable to load pipeline data. Will retry.</p>';
  }
}

function refresh() { loadSummary(); loadEvents(); loadHeartbeats(); loadSpecFlow(); }
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}
