import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingSummary } from './WaitingSummary.js';

describe('waiting state', () => {
  it('renders the reason and machine-readable next check, including disabled scheduling', () => {
    const wait = { generation: 1, state:'active',kind:'time' as const,reason:'Run tonight',notBefore:'2030-01-01T22:00:00Z' };
    const enabled = renderToStaticMarkup(<WaitingSummary wait={wait} enabled />);
    expect(enabled).toContain('Run tonight'); expect(enabled).toContain('dateTime="2030-01-01T22:00:00Z"');
    expect(enabled).not.toContain('disabled');
    const disabled = renderToStaticMarkup(<WaitingSummary wait={wait} enabled={false} />);
    expect(disabled).toContain('Automatic scheduling is disabled'); expect(disabled).toContain('Run now is available');
  });
});
