/** Weather route helpers.
 *
 *  The handler itself needs `request.cf` and an outbound fetch, so the parts
 *  worth pinning are the pure ones: coordinate validation (they are used to
 *  build an outbound URL) and WMO code mapping (it must not invent a
 *  condition it does not know). */

import { describe, it, expect } from 'vitest';
import { conditionFromCode, coordinate } from '../../src/pages/api/v1/weather';

describe('coordinate', () => {
  it('accepts a valid latitude or longitude, as string or number', () => {
    expect(coordinate('28.61', 90)).toBe(28.61);
    expect(coordinate(77.23, 180)).toBe(77.23);
    expect(coordinate('-33.87', 90)).toBe(-33.87);
    expect(coordinate('0', 90)).toBe(0);
  });

  it('rejects out-of-range values', () => {
    expect(coordinate('91', 90)).toBeNull();
    expect(coordinate('-91', 90)).toBeNull();
    expect(coordinate('181', 180)).toBeNull();
  });

  /** These values are interpolated into an outbound URL, so anything
   *  unparseable must be rejected rather than concatenated in. */
  it('rejects anything unparseable', () => {
    for (const bad of ['', 'abc', null, undefined, {}, [], 'NaN', 'Infinity', '1e999']) {
      expect(coordinate(bad, 90)).toBeNull();
    }
  });

  it('rejects an injection attempt in a coordinate', () => {
    expect(coordinate('28.61&foo=bar', 90)).toBeNull();
    expect(coordinate('28.61 OR 1=1', 90)).toBeNull();
  });
});

describe('conditionFromCode', () => {
  it('maps known WMO codes', () => {
    expect(conditionFromCode(0)).toBe('clear');
    expect(conditionFromCode(3)).toBe('overcast');
    expect(conditionFromCode(65)).toBe('heavy-rain');
    expect(conditionFromCode(95)).toBe('thunderstorm');
  });

  // An unmapped code becomes 'unknown' rather than being forced into the
  // nearest label — reporting the wrong weather is worse than reporting none.
  it('returns unknown for unmapped or invalid codes', () => {
    for (const bad of [7, 999, -1, '0', null, undefined, {}, Number.NaN]) {
      expect(conditionFromCode(bad)).toBe('unknown');
    }
  });
});
