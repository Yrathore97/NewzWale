import { describe, it, expect } from 'vitest';
import { parseRss } from '../../src/lib/news/rss';

const SAMPLE = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>ISRO launches NavIC satellite</title>
    <link>https://example.com/isro</link>
    <description>A routine launch from Sriharikota.</description>
    <pubDate>Tue, 05 Aug 2026 04:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

describe('parseRss', () => {
  it('extracts items', () => {
    const out = parseRss(SAMPLE, 'thehindu');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('ISRO launches NavIC satellite');
    expect(out[0].source).toBe('thehindu');
  });

  it('unwraps CDATA titles', () => {
    const xml = `<rss><channel><item><title><![CDATA[Budget 2026]]></title><link>https://e.com/a</link></item></channel></rss>`;
    expect(parseRss(xml, 'mint')[0].title).toBe('Budget 2026');
  });

  describe('image extraction', () => {
    const item = (inner: string) =>
      `<rss><channel><item><title>T</title><link>https://x.com/a</link>${inner}</item></channel></rss>`;

    // Every form below appears in the feeds this parser actually reads.
    it('reads media:content', () => {
      const [a] = parseRss(item('<media:content url="https://cdn.x.com/1.jpg" />'), 's');
      expect(a.imageUrl).toBe('https://cdn.x.com/1.jpg');
    });

    it('reads media:thumbnail', () => {
      const [a] = parseRss(item('<media:thumbnail url="https://cdn.x.com/t.jpg" />'), 's');
      expect(a.imageUrl).toBe('https://cdn.x.com/t.jpg');
    });

    it('reads an image enclosure', () => {
      const [a] = parseRss(
        item('<enclosure url="https://cdn.x.com/e.jpg" type="image/jpeg" />'),
        's',
      );
      expect(a.imageUrl).toBe('https://cdn.x.com/e.jpg');
    });

    it('reads a nested <image><url>', () => {
      const [a] = parseRss(item('<image><url>https://cdn.x.com/n.jpg</url></image>'), 's');
      expect(a.imageUrl).toBe('https://cdn.x.com/n.jpg');
    });

    it('handles attributes in any order', () => {
      const [a] = parseRss(
        item('<media:content type="image/jpeg" width="600" url="https://cdn.x.com/1.jpg" />'),
        's',
      );
      expect(a.imageUrl).toBe('https://cdn.x.com/1.jpg');
    });

    it('prefers media:content over a thumbnail', () => {
      const [a] = parseRss(
        item(
          '<media:thumbnail url="https://cdn.x.com/small.jpg" />' +
            '<media:content url="https://cdn.x.com/full.jpg" />',
        ),
        's',
      );
      expect(a.imageUrl).toBe('https://cdn.x.com/full.jpg');
    });

    // RSS 2.0 uses <enclosure> for podcasts too. An audio URL in an <img src>
    // would be a broken image on every card.
    it('ignores a non-image enclosure', () => {
      const [a] = parseRss(
        item('<enclosure url="https://cdn.x.com/ep.mp3" type="audio/mpeg" />'),
        's',
      );
      expect(a.imageUrl).toBeNull();
    });

    it('accepts a typeless enclosure only when it looks like an image', () => {
      const [img] = parseRss(item('<enclosure url="https://cdn.x.com/e.png" />'), 's');
      expect(img.imageUrl).toBe('https://cdn.x.com/e.png');

      const [other] = parseRss(item('<enclosure url="https://cdn.x.com/doc.pdf" />'), 's');
      expect(other.imageUrl).toBeNull();
    });

    // A feed is untrusted input rendered into an attribute.
    it('rejects unsafe schemes', () => {
      const [a] = parseRss(item('<media:content url="javascript:alert(1)" />'), 's');
      expect(a.imageUrl).toBeNull();
    });

    it('falls back to null when no image is present', () => {
      const [a] = parseRss(item(''), 's');
      expect(a.imageUrl).toBeNull();
    });
  });

  it('returns an empty array for malformed input', () => {
    expect(parseRss('not xml', 'x')).toEqual([]);
  });
});
