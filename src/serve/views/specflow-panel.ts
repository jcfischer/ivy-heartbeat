import type { SpecFlowFeature } from '../../blackboard.ts';

export const ACTIVE_PHASES = new Set([
  'specifying', 'planning', 'tasking', 'implementing', 'completing',
]);

export const DISPLAY_PHASES = [
  'queued', 'specifying', 'specified', 'planning', 'planned',
  'tasking', 'tasked', 'implementing', 'implemented', 'completing', 'completed',
];

export function phaseState(
  feature: SpecFlowFeature,
  phase: string,
): 'completed' | 'active' | 'pending' {
  const idx = DISPLAY_PHASES.indexOf(phase);
  const cur = DISPLAY_PHASES.indexOf(feature.phase);
  if (idx < 0) return 'pending'; // unknown phase
  if (idx < cur) return 'completed';
  if (idx === cur && ACTIVE_PHASES.has(phase)) return 'active';
  if (idx === cur) return 'completed'; // *ed terminal states
  return 'pending';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTimeAgo(ts: string): string {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d / 60) + 'm ago';
  if (d < 86400) return Math.round(d / 3600) + 'h ago';
  return Math.round(d / 86400) + 'd ago';
}

function renderPhaseTrack(feature: SpecFlowFeature): string {
  if (feature.status === 'failed') {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#ef444420;color:#ef4444;font-size:12px;font-weight:600;">&#10007; failed</span>`;
  }
  if (feature.status === 'blocked') {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#f9731620;color:#f97316;font-size:12px;font-weight:600;">&#9888; blocked</span>`;
  }

  const dots = DISPLAY_PHASES.map((phase) => {
    const state = phaseState(feature, phase);
    const shortName = phase.slice(0, 4);
    if (state === 'completed') {
      return `<span data-phase="${phase}" data-state="completed" title="${phase}" style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;margin:0 1px"><span style="color:#22c55e;font-size:10px;">&#9679;</span><span style="color:#22c55e;font-size:8px;">${shortName}</span></span>`;
    }
    if (state === 'active') {
      return `<span data-phase="${phase}" data-state="active" title="${phase}" style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;margin:0 1px"><span style="color:#3b82f6;font-size:10px;">&#9679;</span><span style="color:#3b82f6;font-size:8px;font-weight:700;">${shortName}</span></span>`;
    }
    return `<span data-phase="${phase}" data-state="pending" title="${phase}" style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;margin:0 1px"><span style="color:#4b5563;font-size:10px;">&#9675;</span><span style="color:#4b5563;font-size:8px;">${shortName}</span></span>`;
  }).join('');

  return `<span style="display:inline-flex;align-items:flex-end;">${dots}</span>`;
}

function renderScores(feature: SpecFlowFeature): string {
  const s = (v: number | null) => v !== null ? String(v) : '&ndash;';
  return `${s(feature.specify_score)} / ${s(feature.plan_score)} / ${s(feature.implement_score)}`;
}

function renderFailures(feature: SpecFlowFeature): string {
  if (feature.failure_count === 0) return '&ndash;';
  const isMax = feature.failure_count >= feature.max_failures;
  const color = isMax ? '#ef4444' : '#f97316';
  return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${color}20;color:${color};font-size:12px;font-weight:600;">${feature.failure_count}/${feature.max_failures}</span>`;
}

function renderPR(feature: SpecFlowFeature): string {
  if (feature.pr_url && feature.pr_url.startsWith('https://') && feature.pr_number !== null) {
    return `<a href="${escapeHtml(feature.pr_url)}" target="_blank" style="color:#4fc3f7;text-decoration:none;">#${feature.pr_number}</a>`;
  }
  return '&ndash;';
}

function renderRow(feature: SpecFlowFeature): string {
  const title = escapeHtml(feature.title.slice(0, 40)) + (feature.title.length > 40 ? '&hellip;' : '');
  return `
    <tr data-feature-id="${escapeHtml(feature.feature_id)}" style="cursor:pointer;border-bottom:1px solid #1f2937;">
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;white-space:nowrap;color:#4fc3f7;">${escapeHtml(feature.feature_id)}</td>
      <td style="padding:8px 12px;font-size:13px;color:#9ca3af;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(feature.title)}">${title}</td>
      <td style="padding:8px 12px;white-space:nowrap;">${renderPhaseTrack(feature)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#9ca3af;white-space:nowrap;">${renderScores(feature)}</td>
      <td style="padding:8px 12px;white-space:nowrap;">${renderFailures(feature)}</td>
      <td style="padding:8px 12px;white-space:nowrap;">${renderPR(feature)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#6b7280;white-space:nowrap;">${relTimeAgo(feature.updated_at)}</td>
    </tr>`;
}

export function renderSpecFlowPanel(features: SpecFlowFeature[]): string {
  if (features.length === 0) {
    return `<div style="padding:16px;color:#6b7280;font-style:italic;">No active SpecFlow features.</div>`;
  }

  const rows = features.map(renderRow).join('');

  return `
<div style="overflow-x:auto;">
  <table style="width:100%;border-collapse:collapse;font-family:system-ui,-apple-system,sans-serif;font-size:13px;">
    <thead>
      <tr style="border-bottom:2px solid #374151;">
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;white-space:nowrap;">FEATURE</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;">TITLE</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;white-space:nowrap;">PIPELINE</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;white-space:nowrap;">SCORES</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;white-space:nowrap;">FAILS</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;">PR</th>
        <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:11px;font-weight:600;white-space:nowrap;">UPDATED</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>
<script>
(function() {
  var expanded = null;
  document.querySelectorAll('[data-feature-id]').forEach(function(row) {
    row.addEventListener('click', async function() {
      var id = this.getAttribute('data-feature-id');
      var existingTl = document.getElementById('tl-' + id);
      if (existingTl) {
        existingTl.remove();
        expanded = null;
        return;
      }
      if (expanded) {
        var prev = document.getElementById('tl-' + expanded);
        if (prev) prev.remove();
      }
      expanded = id;
      var tr = document.createElement('tr');
      tr.id = 'tl-' + id;
      tr.innerHTML = '<td colspan="7" style="padding:8px 16px;background:#111;color:#6b7280;font-style:italic;">Loading events\u2026</td>';
      this.insertAdjacentElement('afterend', tr);
      try {
        var res = await fetch('/api/specflow/features/' + encodeURIComponent(id) + '/events');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var events = await res.json();
        if (!Array.isArray(events) || events.length === 0) {
          tr.querySelector('td').textContent = 'No events found for this feature.';
          return;
        }
        var html = '<td colspan="7" style="padding:0;background:#0d0d0d;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
        html += '<tr style="border-bottom:1px solid #1f2937;"><th style="padding:4px 12px;color:#6b7280;text-align:left;font-weight:500;">TIME</th><th style="padding:4px 12px;color:#6b7280;text-align:left;font-weight:500;">EVENT</th></tr>';
        events.forEach(function(r) {
          var e = r.event || r;
          var ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '?';
          var summary = (e.summary || '').slice(0, 120);
          var safeTs = document.createElement('span');
          safeTs.textContent = ts;
          var safeSummary = document.createElement('span');
          safeSummary.textContent = summary;
          html += '<tr style="border-bottom:1px solid #1f2937;"><td style="padding:4px 12px;color:#6b7280;white-space:nowrap;">' + safeTs.innerHTML + '</td><td style="padding:4px 12px;color:#d1d5db;">' + safeSummary.innerHTML + '</td></tr>';
        });
        html += '</table></td>';
        tr.innerHTML = html;
      } catch(err) {
        var td = tr.querySelector('td');
        if (td) td.textContent = 'Error loading events: ' + (err.message || String(err));
      }
    });
  });
})();
</script>`;
}
