/*
 * KV-cache helpers for ChessMind exports with a cache (manifest `kv_cache`). Keys are cached after rotate-half RoPE
 * (pairs (x[i], x[i + headDim/2]) rotated by pos * inv_freq_i, inv_freq_i = theta^(-2i/headDim), as ChessMind's
 * transformer.apply_rope), token-major: [tokens, heads, headDim] per layer.
 */

/** Tokens at the start of a sequence that stay when a full context slides (attention sinks, as in StreamingLLM). */
export const KV_SINKS = 4;

/**
 * Move `count` cached keys from token `from` to token `to` (< from) in place and re-rotate them to their new positions,
 * i.e. by `to - from`. A rotation composes, so R(to - from) R(pos) k = R(pos - (from - to)) k: the keys read as if the
 * tokens had been at the earlier positions. (Values carry no position: move them with copyWithin.)
 */
export function moveKeys(buf: Float32Array, from: number, to: number, count: number, heads: number, headDim: number, theta: number): void {
  const half = headDim / 2;
  const delta = to - from;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const angle = delta * Math.pow(theta, (-2 * i) / headDim);
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  const stride = heads * headDim;
  for (let t = 0; t < count; t++) {
    const src = (from + t) * stride;
    const dst = (to + t) * stride;
    for (let h = 0; h < heads; h++) {
      const a = src + h * headDim;
      const b = dst + h * headDim;
      for (let i = 0; i < half; i++) {
        const x1 = buf[a + i];
        const x2 = buf[a + half + i];
        buf[b + i] = x1 * cos[i] - x2 * sin[i];
        buf[b + half + i] = x1 * sin[i] + x2 * cos[i];
      }
    }
  }
}

/**
 * Leading tokens a cache can reuse: equal ids AND equal board rows (the rows feed the board embedding, so the same ids
 * with different rows -- a cropped game seeded at another position, a line after a different snapshot -- have
 * different keys and values).
 */
export function sharedPrefix(cachedIds: number[], cachedRows: (number[] | undefined)[], ids: number[], rows?: (number[] | undefined)[]): number {
  const n = Math.min(cachedIds.length, ids.length);
  let i = 0;
  while (i < n && cachedIds[i] === ids[i] && sameRow(cachedRows[i], rows?.[i])) i++;
  return i;
}

function sameRow(a: number[] | undefined, b: number[] | undefined): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((c, i) => c === b[i]));
}

/** FNV-1a (32-bit) over the codes of board rows: the worker's debug log compares it with Python's BoardTracker rows. */
export function rowsHash(rows: (number[] | undefined)[] | undefined): string {
  let h = 0x811c9dc5;
  for (const r of rows ?? []) for (const c of r ?? []) h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
