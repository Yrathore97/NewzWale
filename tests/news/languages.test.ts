import { describe, it, expect } from 'vitest';
import {
  LANGUAGES,
  isValidLanguage,
  DEFAULT_LANGUAGE,
  languageDir,
} from '../../src/lib/news/languages';

describe('LANGUAGES', () => {
  it('lists English first as the default', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(LANGUAGES[0].code).toBe('en');
  });

  it('gives every language a two-letter code and a non-empty name', () => {
    for (const l of LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2}$/);
      expect(l.name.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate codes', () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('languageDir', () => {
  it('marks Urdu right-to-left', () => {
    expect(languageDir('ur')).toBe('rtl');
  });

  it('marks every other offered language left-to-right', () => {
    for (const l of LANGUAGES) {
      if (l.code === 'ur') continue;
      expect(languageDir(l.code)).toBe('ltr');
    }
  });

  // A bad ?language= value must not be able to break the page shell, so this
  // falls back rather than throwing.
  it('falls back to ltr for unknown and non-string values', () => {
    expect(languageDir('xx')).toBe('ltr');
    expect(languageDir('')).toBe('ltr');
    expect(languageDir(null)).toBe('ltr');
    expect(languageDir(undefined)).toBe('ltr');
    expect(languageDir(7)).toBe('ltr');
  });

  it('declares a direction for every language, so none can be added without one', () => {
    for (const l of LANGUAGES) {
      expect(['ltr', 'rtl']).toContain(l.dir);
    }
  });
});

describe('isValidLanguage', () => {
  it('accepts every declared code', () => {
    for (const l of LANGUAGES) expect(isValidLanguage(l.code)).toBe(true);
  });

  it('rejects unknown, empty, and injection-shaped values', () => {
    expect(isValidLanguage('xx')).toBe(false);
    expect(isValidLanguage('')).toBe(false);
    expect(isValidLanguage('en&country=us')).toBe(false);
    expect(isValidLanguage('EN')).toBe(false);
    expect(isValidLanguage(null)).toBe(false);
    expect(isValidLanguage(undefined)).toBe(false);
    expect(isValidLanguage(7)).toBe(false);
  });
});
