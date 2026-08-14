import { describe, it, expect } from 'vitest';
import { toBlocks, stripChrome, extractRelevantPassage } from '../../src/lib/factcheck/passage';

describe('toBlocks', () => {
  it('splits block-level elements into separate blocks', () => {
    const blocks = toBlocks('<p>First paragraph.</p><p>Second paragraph.</p>');
    expect(blocks).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('drops chrome elements and boilerplate lines', () => {
    const html =
      '<nav>Home About</nav><div class="cookie-banner">Accept all cookies</div>' +
      '<p>Real article text about a policy change.</p><footer>All rights reserved</footer>';
    const blocks = toBlocks(html);
    expect(blocks).toEqual(['Real article text about a policy change.']);
  });

  it('does not leak a SINGLE-quoted attribute whose value contains ">" and nested double quotes', () => {
    // The exact shape that broke on the live Agra-Lucknow Expressway article.
    // Wikipedia's Parsoid HTML puts the page's infobox and citation wikitext
    // in a single-quoted data-mw attribute holding JSON - so the value has
    // both ">" characters AND nested double quotes. `stripChrome`'s chrome
    // matcher scanned attributes with `[^>]*`, ended the opening tag at the
    // first ">" inside that JSON, and re-emitted the remainder as prose.
    //
    // The span carries a class that is NOT chrome, which is what routes it
    // down the re-emitting branch - a chrome class would have been dropped
    // wholesale and hidden the bug.
    const html =
      '<p>Lede sentence establishing the topic.</p>' +
      `<span class="mw-empty-elt" data-mw='{"parts":[{"template":{"params":{"formed":{"wt":"21 November 2016<ref>{{cite news|url=http://x.example/y}}</ref>"}}}}]}'>` +
      '</span>' +
      '<p>The expressway opened to traffic in November 2016 under the state government.</p>';
    const joined = toBlocks(html).join(' ');
    expect(joined).not.toContain('cite news');
    expect(joined).not.toContain('"wt"');
    expect(joined).not.toContain('parts');
    expect(joined).toContain('The expressway opened to traffic in November 2016 under the state government.');
  });
});

describe('stripChrome', () => {
  it('removes an element by its chrome class, contents and all', () => {
    const out = stripChrome('<div class="social-share">Share on Twitter</div><p>Article body.</p>');
    expect(out).not.toContain('Share on Twitter');
    expect(out).toContain('Article body.');
  });

  it('removes elements whose content is never article text', () => {
    const out = stripChrome('<script>track()</script><nav>Home</nav><p>Body text.</p>');
    expect(out).not.toContain('track()');
    expect(out).not.toContain('Home');
    expect(out).toContain('Body text.');
  });
});

describe('extractRelevantPassage', () => {
  const CLAIM = 'The Reserve Bank cut its benchmark interest rate to 6.25 percent.';
  const SUPPORTING = 'The Reserve Bank cut its benchmark interest rate to 6.25 percent on Thursday.';

  it('selects the block that engages the claim over chrome', () => {
    const html =
      '<nav>Home About Contact</nav>' +
      '<p>Advertisement: subscribe today.</p>' +
      `<p>${SUPPORTING}</p>`;
    const out = extractRelevantPassage(html, CLAIM);
    expect(out.text).toContain('cut its benchmark interest rate');
    expect(out.targeted).toBe(true);
  });

  it('does not select a block built from a leaked quoted attribute', () => {
    // Same underlying defect as the toBlocks case, checked at the level
    // that actually feeds the stance classifier: a passage full of
    // `{{cite ...}}` and `"wt":"..."` fragments must never be selected as
    // if it were relevant prose.
    const html =
      '<sup data-mw="{&quot;body&quot;:&quot;{{cite news|url=x}}</ref>&quot;,&quot;wt&quot;:&quot;irrelevant metadata about Uttar Pradesh&quot;}">[1]</sup>' +
      `<p>${SUPPORTING}</p>`;
    const out = extractRelevantPassage(html, CLAIM);
    expect(out.text).not.toContain('cite news');
    expect(out.text).not.toContain('"wt"');
    expect(out.text).toContain('cut its benchmark interest rate');
  });
});
