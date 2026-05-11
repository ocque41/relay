import { describe, it, expect } from 'vitest';
import {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  CategoryValidationError,
  normalizeCategoriesLoose,
  normalizeCategoriesOrThrow,
  resolveCategory,
} from './categories';

describe('resolveCategory', () => {
  it('returns a canonical slug unchanged', () => {
    expect(resolveCategory('database')).toBe('database');
    expect(resolveCategory('hosting')).toBe('hosting');
    expect(resolveCategory('email')).toBe('email');
  });

  it('lowercases and trims before resolving', () => {
    expect(resolveCategory('  Database  ')).toBe('database');
    expect(resolveCategory('HOSTING')).toBe('hosting');
  });

  it('resolves aliases to their canonical slug', () => {
    expect(resolveCategory('hoster')).toBe('hosting');
    expect(resolveCategory('host')).toBe('hosting');
    expect(resolveCategory('mail')).toBe('email');
    expect(resolveCategory('transactional')).toBe('email');
    expect(resolveCategory('db')).toBe('database');
    expect(resolveCategory('logs')).toBe('observability');
  });

  it('returns null for empty or unknown input', () => {
    expect(resolveCategory('')).toBeNull();
    expect(resolveCategory('   ')).toBeNull();
    expect(resolveCategory('widgets')).toBeNull();
    expect(resolveCategory('does-not-exist')).toBeNull();
  });

  it('covers every alias key with a valid canonical target', () => {
    for (const target of Object.values(CATEGORY_ALIASES)) {
      expect(CANONICAL_CATEGORIES).toContain(target);
    }
  });
});

describe('normalizeCategoriesOrThrow', () => {
  it('returns canonicalized, deduplicated slugs', () => {
    expect(normalizeCategoriesOrThrow(['database', 'hoster', 'Hosting'])).toEqual([
      'database',
      'hosting',
    ]);
  });

  it('throws CategoryValidationError with invalid inputs listed', () => {
    let caught: unknown = null;
    try {
      normalizeCategoriesOrThrow(['database', 'widgets', 'not-a-thing']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CategoryValidationError);
    const e = caught as CategoryValidationError;
    expect(e.invalid).toEqual(['widgets', 'not-a-thing']);
    expect(e.canonical).toEqual(CANONICAL_CATEGORIES);
    expect(e.message).toContain('widgets');
  });

  it('accepts an empty input and returns an empty array', () => {
    expect(normalizeCategoriesOrThrow([])).toEqual([]);
  });
});

describe('normalizeCategoriesLoose', () => {
  it('drops unknown strings silently', () => {
    expect(
      normalizeCategoriesLoose(['database', 'widgets', 'hoster', 'not-a-thing']),
    ).toEqual(['database', 'hosting']);
  });

  it('ignores non-string entries', () => {
    expect(normalizeCategoriesLoose(['database', 42, null, undefined, {}])).toEqual([
      'database',
    ]);
  });

  it('deduplicates after alias resolution', () => {
    expect(normalizeCategoriesLoose(['hosting', 'hoster', 'host'])).toEqual([
      'hosting',
    ]);
  });
});
