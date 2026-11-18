import { describe, expect, it } from 'vitest';
import { upstreamChoices } from './upstream-choices';

describe('the version form per upstream configuration (P-04)', () => {
  it('with the node only, does not ask: node details, node sandbox', () => {
    expect(upstreamChoices(['node'])).toEqual({
      types: ['node'],
      ask: false,
      initial: 'node',
      sandbox: ['none', 'node'],
    });
  });

  it('with the node and X-Road, asks between them, node first; no URL sandbox', () => {
    expect(upstreamChoices(['xroad', 'node'])).toEqual({
      types: ['node', 'xroad'],
      ask: true,
      initial: 'node',
      sandbox: ['none', 'node'],
    });
  });

  it('offers direct, as upstream and sandbox, only where the country opts in', () => {
    expect(upstreamChoices(['node', 'xroad', 'direct'])).toMatchObject({
      types: ['node', 'xroad', 'direct'],
      ask: true,
      sandbox: ['none', 'node', 'direct'],
    });
    expect(upstreamChoices(['direct'])).toEqual({
      types: ['direct'],
      ask: false,
      initial: 'direct',
      sandbox: ['none', 'direct'],
    });
  });

  it('with X-Road only, does not ask and offers no sandbox but none', () => {
    expect(upstreamChoices(['xroad'])).toEqual({
      types: ['xroad'],
      ask: false,
      initial: 'xroad',
      sandbox: ['none'],
    });
  });
});
