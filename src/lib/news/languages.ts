/** News-content languages the site offers. This is NOT interface translation -
 *  the UI chrome stays English; only the headlines change language.
 *
 *  These codes are what NewsData.io advertises for India. Which of them
 *  actually return results has NOT yet been verified against the live API;
 *  a language that returns nothing must be removed rather than left in to
 *  disappoint. */
export interface Language {
  code: string;
  name: string;
  /** Base writing direction for content in this language. Only Urdu, written
   *  in the Nastaliq/Arabic script, is right-to-left. */
  dir: 'ltr' | 'rtl';
}

export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'hi', name: 'हिंदी (Hindi)', dir: 'ltr' },
  { code: 'bn', name: 'বাংলা (Bengali)', dir: 'ltr' },
  { code: 'mr', name: 'मराठी (Marathi)', dir: 'ltr' },
  { code: 'te', name: 'తెలుగు (Telugu)', dir: 'ltr' },
  { code: 'ta', name: 'தமிழ் (Tamil)', dir: 'ltr' },
  { code: 'gu', name: 'ગુજરાતી (Gujarati)', dir: 'ltr' },
  { code: 'kn', name: 'ಕನ್ನಡ (Kannada)', dir: 'ltr' },
  { code: 'ml', name: 'മലയാളം (Malayalam)', dir: 'ltr' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ (Punjabi)', dir: 'ltr' },
  { code: 'or', name: 'ଓଡ଼ିଆ (Odia)', dir: 'ltr' },
  { code: 'as', name: 'অসমীয়া (Assamese)', dir: 'ltr' },
  { code: 'ur', name: 'اردو (Urdu)', dir: 'rtl' },
];

const CODES = new Set(LANGUAGES.map((l) => l.code));

export function isValidLanguage(code: unknown): code is string {
  return typeof code === 'string' && CODES.has(code);
}

/** Writing direction for a content language code.
 *
 *  `<html lang>` was hardcoded to "en" across all 13 languages, which told
 *  screen readers to pronounce Hindi and Tamil headlines with English phonetics
 *  (audit A-01). Unknown codes fall back to ltr rather than throwing: a bad
 *  ?language= value should not be able to break the page shell. */
export function languageDir(code: unknown): 'ltr' | 'rtl' {
  return LANGUAGES.find((l) => l.code === code)?.dir ?? 'ltr';
}
