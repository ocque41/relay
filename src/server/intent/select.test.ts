import { describe, it, expect } from 'vitest';
import { selectProvider, type SelectableProvider } from './select';

const free: SelectableProvider = { id: 'free-x', categories: ['database'], pricingModel: 'free' };
const freeTier: SelectableProvider = { id: 'free-tier-x', categories: ['database'], pricingModel: 'free-tier' };
const paid: SelectableProvider = { id: 'paid-x', categories: ['database'], pricingModel: 'paid' };
const noPricing: SelectableProvider = { id: 'noprice', categories: ['database'] };
const wrongCategory: SelectableProvider = { id: 'email-x', categories: ['email'], pricingModel: 'free' };

describe('selectProvider', () => {
  it('returns none when nothing serves the category', () => {
    expect(selectProvider('database', [wrongCategory])).toEqual({ kind: 'none' });
    expect(selectProvider('database', [])).toEqual({ kind: 'none' });
  });

  it('returns the lone candidate without ambiguity', () => {
    expect(selectProvider('database', [paid])).toEqual({ kind: 'one', provider: paid });
  });

  it('prefers free over free-tier over paid', () => {
    const r = selectProvider('database', [paid, freeTier, free]);
    expect(r).toEqual({ kind: 'one', provider: free });
  });

  it('breaks ties on alphabetical id', () => {
    const a: SelectableProvider = { id: 'a', categories: ['database'], pricingModel: 'paid' };
    const b: SelectableProvider = { id: 'b', categories: ['database'], pricingModel: 'paid' };
    // Two paid providers at the same rank → ambiguous
    expect(selectProvider('database', [b, a])).toEqual({
      kind: 'ambiguous',
      candidates: [a, b],
    });
  });

  it('flags ambiguous when the top tier has multiple equally-priced providers', () => {
    const aFree: SelectableProvider = { id: 'a-free', categories: ['database'], pricingModel: 'free' };
    const bFree: SelectableProvider = { id: 'b-free', categories: ['database'], pricingModel: 'free' };
    const r = selectProvider('database', [aFree, bFree, paid]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map((p) => p.id)).toEqual(['a-free', 'b-free']);
    }
  });

  it('treats missing pricing as the worst rank', () => {
    const r = selectProvider('database', [noPricing, paid]);
    expect(r).toEqual({ kind: 'one', provider: paid });
  });

  it('filters by category exact match', () => {
    const r = selectProvider('email', [free, freeTier, wrongCategory]);
    expect(r).toEqual({ kind: 'one', provider: wrongCategory });
  });
});
