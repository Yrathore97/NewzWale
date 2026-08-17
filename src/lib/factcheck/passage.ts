/** Turning a fetched page into the passage that actually bears on the claim.
 *
 *  ── WHAT CHANGED AND WHY ───────────────────────────────────────────────────
 *
 *  Before: page -> strip tags -> first 1500 characters -> model.
 *  That handed the model a cookie banner, a nav menu and a subscription
 *  prompt, then asked it to judge a claim. The relevant sentence, if present,
 *  was often past the cut.
 *
 *  Now: page -> remove chrome -> split into blocks -> keep the blocks that
 *  engage the claim -> bounded passage.
 *
 *  ── COPYRIGHT ──────────────────────────────────────────────────────────────
 *
 *  This deliberately extracts a BOUNDED EXCERPT, not the article. The cap is a
 *  product rule, not a performance one: NewzWale quotes what a verdict rests
 *  on so a reader can check it, and reproducing the article would make us a
 *  republisher of someone else's work. */

import { assessRelevance } from './relevance';

/** Absolute ceiling on an extracted passage. */
export const MAX_PASSAGE_CHARS = 1500;
/** Ceiling on any single quoted block. */
export const MAX_BLOCK_CHARS = 600;
/** Blocks below this are captions, bylines or nav fragments. */
const MIN_BLOCK_CHARS = 40;

/** Elements whose CONTENT is never article text. Removed wholesale, including
 *  children — a nav's links are not evidence. */
const STRIP_ELEMENTS = [
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'canvas',
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'video', 'audio',
];

/** Class/id fragments that mark chrome on essentially every news site. */
const CHROME_PATTERNS =
  /(?:^|[\s_-])(nav|menu|header|footer|sidebar|aside|banner|cookie|consent|gdpr|subscribe|newsletter|paywall|promo|advert|ad-|ads-|social|share|comment|related|recommend|trending|popular|breadcrumb|pagination|widget|modal|popup|overlay|toolbar|masthead)(?:[\s_-]|$)/i;

/** Lines that are chrome even when they survive structural stripping. */
const BOILERPLATE_LINE =
  /^(?:home|about|contact|subscribe|sign in|sign up|log in|menu|search|share|follow us|advertisement|sponsored|related stories?|read more|click here|accept (?:all )?cookies?|we use cookies|privacy policy|terms(?: of (?:use|service))?|all rights reserved|copyright|©.*)$/i;

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”',
};

/** ONE HTML tag, quote-aware — as a source string so it can be composed into
 *  larger patterns as well as used on its own.
 *
 *  The naive `<[^>]*>` ends a tag at the FIRST `>`, including one inside a
 *  quoted attribute value. That is not a theoretical concern: Wikipedia's
 *  Parsoid HTML carries a page's entire infobox and citation wikitext in a
 *  SINGLE-quoted `data-mw='{"parts":[...]}'` attribute whose JSON payload
 *  contains both `>` characters and nested double quotes. On the live
 *  Agra–Lucknow Expressway article that attribute is ~1,200 characters long.
 *
 *  Consuming a quoted string as one unit — either quote style, `>` included —
 *  keeps that payload inside the tag where it belongs. Both quote forms are
 *  listed because the failing attribute used single quotes around JSON that
 *  used double quotes internally. */
const TAG_SOURCE = String.raw`<(?:[^>"']|"[^"]*"|'[^']*')*>`;
const TAG_RE = new RegExp(TAG_SOURCE, 'g');
/** The attribute-scanning half of a tag: everything up to the closing `>`,
 *  quoted values consumed whole. */
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;

function decodeEntities(text: string): string {
  return text
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      const named = ENTITIES[m.toLowerCase()];
      if (named) return named;
      const numeric = m.match(/&#(\d+);/);
      if (numeric) {
        const code = Number(numeric[1]);
        // Bounded: an out-of-range code point would throw.
        if (code > 0 && code < 0x10ffff) return String.fromCodePoint(code);
      }
      return ' ';
    });
}

/** Removes elements whose content is never article text, plus any element
 *  whose class or id marks it as chrome. */
export function stripChrome(html: string): string {
  let out = html;

  for (const tag of STRIP_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    // Unclosed tags are common in real HTML; drop the opening tag too.
    out = out.replace(new RegExp(`<${tag}\\b${ATTRS}/?>`, 'gi'), ' ');
  }

  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  // Divs/sections carrying a chrome class or id, with their contents.
  //
  // ATTRS rather than `[^>]*` on BOTH sides of the class/id capture. With the
  // naive form this pattern was the specific thing that leaked Wikipedia's
  // `data-mw` payload: it ended the opening tag at the first `>` inside that
  // attribute's JSON, and then the non-chrome branch below re-emitted the
  // mangled remainder as if it were prose. Confirmed against the live article.
  out = out.replace(
    new RegExp(
      `<(div|section|ul|ol|li|span)\\b${ATTRS}?(?:class|id)\\s*=\\s*["']([^"']*)["']${ATTRS}>([\\s\\S]*?)</\\1>`,
      'gi',
    ),
    (match, _tag, attr: string, inner: string) =>
      CHROME_PATTERNS.test(attr) ? ' ' : match.replace(TAG_RE, ' ') + ' ' + inner,
  );

  return out;
}

/** Splits cleaned HTML into candidate text blocks, preserving paragraph
 *  boundaries so a quote can be attributed to one passage. */
export function toBlocks(html: string): string[] {
  const withBreaks = stripChrome(html)
    // Block-level elements become paragraph boundaries.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|figcaption)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(TAG_RE, ' ');

  return decodeEntities(withBreaks)
    .split(/\n{2,}/)
    .map((b) => b.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim())
    .filter((b) => b.length > 0)
    .filter((b) => !BOILERPLATE_LINE.test(b))
    // A block with no sentence-ending punctuation and few words is a label.
    .filter((b) => b.length >= MIN_BLOCK_CHARS || /[.!?]/.test(b));
}

export interface ExtractedPassage {
  /** The bounded passage handed to classification. */
  text: string;
  /** Blocks that were selected, in document order. */
  blocks: string[];
  /** True when relevance ranking chose blocks rather than falling back. */
  targeted: boolean;
  /** True when the cap cut the passage short. */
  truncated: boolean;
  /** Total blocks considered, for diagnostics. */
  blocksConsidered: number;
}

export interface ExtractPassageOptions {
  maxChars?: number;
  /** Maximum blocks to keep. */
  maxBlocks?: number;
}

/** Selects the parts of a page that engage the claim.
 *
 *  Falls back to the opening blocks when nothing scores — a lede is the least
 *  bad default, and returning nothing would silently drop a source that may
 *  well be relevant in a way the scorer missed. The fallback is FLAGGED
 *  (`targeted: false`) so downstream can treat it as weaker. */
export function extractRelevantPassage(
  html: string,
  claim: string,
  options: ExtractPassageOptions = {},
): ExtractedPassage {
  const maxChars = options.maxChars ?? MAX_PASSAGE_CHARS;
  const maxBlocks = options.maxBlocks ?? 6;

  const blocks = toBlocks(html);
  if (blocks.length === 0) {
    return { text: '', blocks: [], targeted: false, truncated: false, blocksConsidered: 0 };
  }

  const scored = blocks
    .map((block, index) => ({
      block: block.slice(0, MAX_BLOCK_CHARS),
      index,
      score: assessRelevance(claim, block).score,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const relevant = scored.filter((s) => s.score > 0.12).slice(0, maxBlocks);
  const targeted = relevant.length > 0;

  // Document order, so quotes read naturally and a reader can find them.
  const chosen = (targeted ? relevant : scored.slice(0, 3)).sort((a, b) => a.index - b.index);

  const kept: string[] = [];
  let total = 0;
  let truncated = false;

  for (const { block } of chosen) {
    if (total + block.length > maxChars) {
      const room = maxChars - total;
      if (room > MIN_BLOCK_CHARS) {
        kept.push(block.slice(0, room));
        total = maxChars;
      }
      truncated = true;
      break;
    }
    kept.push(block);
    total += block.length;
  }

  return {
    text: kept.join('\n\n'),
    blocks: kept,
    targeted,
    truncated,
    blocksConsidered: blocks.length,
  };
}
