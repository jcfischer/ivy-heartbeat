import type { PipelineFeature } from '../api/specflow-pipeline.ts';

const STATUS_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  completed: { bg: '#22c55e20', text: '#22c55e', icon: '&#10003;' },
  in_progress: { bg: '#3b82f620', text: '#3b82f6', icon: '&#9679;' },
  pending: { bg: '#6b728020', text: '#6b7280', icon: '&#9675;' },
  failed: { bg: '#ef444420', text: '#ef4444', icon: '&#10007;' },
};

/**
 * Generate HTML for the SpecFlow pipeline dashboard panel.
 */
export function renderSpecFlowPanel(pipelines: PipelineFeature[]): string {
  if (pipelines.length === 0) {
    return `
      <div style="padding: 16px; color: #6b7280; font-style: italic;">
        No SpecFlow pipelines active.
      </div>
    `;
  }

  const rows = pipelines.map((p) => {
    const phases = p.phase_statuses.map((ps) => {
      const colors = STATUS_COLORS[ps.status] ?? STATUS_COLORS.pending;
      return `
        <span style="
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 4px;
          background: ${colors.bg};
          color: ${colors.text};
          font-size: 12px;
          font-weight: 500;
        ">
          <span>${colors.icon}</span>
          ${ps.phase}
        </span>
      `;
    }).join('<span style="color: #6b7280; margin: 0 2px;">&rarr;</span>');

    const timeAgo = p.last_activity
      ? formatTimeAgo(new Date(p.last_activity))
      : 'unknown';

    return `
      <tr>
        <td style="padding: 8px 12px; font-weight: 600; white-space: nowrap;">
          ${escapeHtml(p.feature_id)}
        </td>
        <td style="padding: 8px 12px; color: #9ca3af; font-size: 13px;">
          ${escapeHtml(p.feature_name)}
        </td>
        <td style="padding: 8px 12px; white-space: nowrap;">
          ${phases}
        </td>
        <td style="padding: 8px 12px; color: #6b7280; font-size: 12px; white-space: nowrap;">
          ${timeAgo}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div style="overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; font-family: system-ui, -apple-system, sans-serif;">
        <thead>
          <tr style="border-bottom: 1px solid #374151;">
            <th style="padding: 8px 12px; text-align: left; color: #9ca3af; font-size: 12px; font-weight: 500;">Feature</th>
            <th style="padding: 8px 12px; text-align: left; color: #9ca3af; font-size: 12px; font-weight: 500;">Name</th>
            <th style="padding: 8px 12px; text-align: left; color: #9ca3af; font-size: 12px; font-weight: 500;">Pipeline</th>
            <th style="padding: 8px 12px; text-align: left; color: #9ca3af; font-size: 12px; font-weight: 500;">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
