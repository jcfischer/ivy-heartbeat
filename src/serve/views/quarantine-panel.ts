import type { BlackboardWorkItem } from '../../blackboard.ts';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTimeAgo(ts: string | null): string {
  if (!ts) return '—';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d / 60) + 'm ago';
  if (d < 86400) return Math.round(d / 3600) + 'h ago';
  return Math.round(d / 86400) + 'd ago';
}

export function renderQuarantinePanel(items: BlackboardWorkItem[]): string {
  if (items.length === 0) {
    return '<p style="color:#555;font-style:italic">No quarantined items. Pipeline is healthy.</p>';
  }

  const rows = items
    .map((item) => {
      const statusColor = item.status === 'quarantined' ? '#ef4444' : '#f97316';
      const statusBg = item.status === 'quarantined' ? '#ef444420' : '#f9731620';
      const badge = `<span style="display:inline-block;padding:2px 6px;border-radius:3px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:600;">${escapeHtml(item.status)}</span>`;

      return `<tr>
        <td style="font-family:monospace;font-size:12px;">${escapeHtml(item.item_id)}</td>
        <td>${escapeHtml(item.title)}</td>
        <td>${badge}</td>
        <td style="text-align:center;">${item.failure_count}</td>
        <td style="color:#9ca3af;font-size:12px;">${escapeHtml(item.failure_reason ?? '—')}</td>
        <td style="color:#9ca3af;font-size:12px;">${relTimeAgo(item.failed_at)}</td>
        <td>
          <button
            onclick="retryItem('${escapeHtml(item.item_id)}')"
            style="padding:3px 10px;background:#1a237e;color:#81d4fa;border:none;border-radius:3px;cursor:pointer;font-size:11px;"
          >Retry</button>
        </td>
      </tr>`;
    })
    .join('');

  return `
    <table>
      <tr>
        <th>Item ID</th>
        <th>Title</th>
        <th>Status</th>
        <th>Failures</th>
        <th>Reason</th>
        <th>Last Failed</th>
        <th>Action</th>
      </tr>
      ${rows}
    </table>
    <script>
      async function retryItem(itemId) {
        if (!confirm('Retry work item ' + itemId + '?')) return;
        const res = await fetch('/api/work-items/' + encodeURIComponent(itemId) + '/retry', { method: 'POST' });
        const body = await res.json();
        if (res.ok) {
          alert('Requeued ' + itemId);
          loadQuarantine();
        } else {
          alert('Error: ' + (body.error || res.statusText));
        }
      }
    </script>
  `;
}
