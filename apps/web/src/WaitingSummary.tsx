import type { TaskWait } from './api.js';
import { tokens } from './ui.js';

export function WaitingSummary({ wait, enabled }: { wait: TaskWait; enabled: boolean }) {
  return <div style={{ color: tokens.muted, fontSize: '0.85rem', marginTop: '0.5rem' }}>
    <p>{wait.reason} · Next check: <time dateTime={wait.notBefore}>{new Date(wait.notBefore).toLocaleString()}</time></p>
    {!!wait.blockers?.length && <ul>{wait.blockers.map((b, i) => <li key={i}>
      {b.assistantId}: {b.reason} ({b.kind}, {b.source}; {b.resetProvenance})
      {b.scope.bucket && ` · ${b.scope.bucket}`}{b.scope.account && ` · account ${b.scope.account}`}
      {' · observed '}<time dateTime={b.observedAt}>{new Date(b.observedAt).toLocaleString()}</time>
    </li>)}</ul>}
    {!enabled && <p role="status">Automatic scheduling is disabled. This task stays waiting; Run now is available.</p>}
  </div>;
}
