import { describe, it, expect } from 'vitest';
import { parseIntent } from './parse';

describe('parseIntent', () => {
  it('matches single-word category nouns', () => {
    expect(parseIntent('postgres').categories).toEqual(['database']);
    expect(parseIntent('email').categories).toEqual(['email']);
    expect(parseIntent('hosting').categories).toEqual(['hosting']);
  });

  it('prefers the longest phrase ("transactional email" beats "email")', () => {
    const r = parseIntent('I need transactional email');
    expect(r.categories).toEqual(['email']);
    expect(r.unmatched).not.toContain('transactional');
  });

  it('combines multiple categories from one prompt', () => {
    const r = parseIntent('Postgres and transactional email for a Next.js app');
    expect(r.categories).toEqual(['database', 'hosting', 'email']);
  });

  it('orders categories by canonical position regardless of input order', () => {
    const r = parseIntent('email then postgres then hosting');
    expect(r.categories).toEqual(['database', 'hosting', 'email']);
  });

  it('dedups categories matched by multiple keywords', () => {
    const r = parseIntent('postgres database with sql');
    expect(r.categories).toEqual(['database']);
  });

  it('emits unmatched terms (debugging aid)', () => {
    const r = parseIntent('postgres plus widgets and gizmos');
    expect(r.categories).toEqual(['database']);
    expect(r.unmatched).toEqual(expect.arrayContaining(['widgets', 'gizmos']));
    expect(r.unmatched).not.toContain('plus');
  });

  it('returns empty categories on no match', () => {
    const r = parseIntent('frobnicate the gizmo');
    expect(r.categories).toEqual([]);
    expect(r.unmatched).toEqual(expect.arrayContaining(['frobnicate', 'gizmo']));
  });

  it('handles ambiguous "I need a database" → returns database', () => {
    const r = parseIntent('I need a database');
    expect(r.categories).toEqual(['database']);
    expect(r.unmatched).toEqual([]);
  });

  it('respects word boundaries (no match inside a longer word)', () => {
    const r = parseIntent('postmortem is not postgres');
    expect(r.categories).toEqual(['database']);
    expect(r.unmatched).toContain('postmortem');
  });

  it('handles punctuation cleanly', () => {
    const r = parseIntent('Postgres, email, and hosting!');
    expect(r.categories).toEqual(['database', 'hosting', 'email']);
  });

  it('multi-category keyword like "vector search" populates both', () => {
    const r = parseIntent('vector search for product reviews');
    expect(r.categories).toEqual(expect.arrayContaining(['ai', 'search']));
  });

  it('returns empty result for empty input', () => {
    expect(parseIntent('')).toEqual({ categories: [], unmatched: [] });
    expect(parseIntent('   ')).toEqual({ categories: [], unmatched: [] });
  });

  it('drops bare numbers from unmatched', () => {
    const r = parseIntent('add 3 databases');
    expect(r.categories).toEqual(['database']);
    expect(r.unmatched).not.toContain('3');
  });
});
