/**
 * Import hand-off from the NoteMate browser extension (extension/lib/handoff.js writes the other side).
 *
 * The extension opens NoteMate at `<app>/#import=chesscom&v=1&d=<payload>`: the payload is the JSON
 * `{ pgn, user?, url? }`, deflate-raw compressed and base64url encoded (`j=` instead of `d=` when it is not
 * compressed). The fragment never reaches the server, needs no content script on NoteMate's origin, works
 * with any NoteMate URL, and compressed PGNs of long games (tens of KB) stay far below browsers' URL limits.
 */

export interface ImportPayload {
  /** Where the game came from (only 'chesscom' so far). */
  source: string;
  pgn: string;
  /** The extension user's chess.com username: their colour sets the board orientation. */
  user?: string;
  /** The game's page. */
  url?: string;
}

/** Largest PGN accepted from a link (a very long game with clock comments is ~40 KB). */
export const MAX_IMPORT_PGN = 2_000_000;

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflateRaw(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_IMPORT_PGN * 2) {
      await reader.cancel();
      throw new Error('import payload too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

/** True when a location hash carries an import (cheap check, no decoding). */
export function isImportHash(hash: string): boolean {
  return /^#?import=/.test(hash);
}

/** Decode an import fragment. Throws on malformed input; returns null when the hash is not an import. */
export async function decodeImportHash(hash: string): Promise<ImportPayload | null> {
  if (!isImportHash(hash)) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const source = params.get('import') ?? '';
  const d = params.get('d');
  const j = params.get('j');
  if (!d && !j) throw new Error('the import link has no game');
  const json = d ? await inflateRaw(base64UrlToBytes(d)) : new TextDecoder().decode(base64UrlToBytes(j!));
  const data = JSON.parse(json) as Partial<ImportPayload>;
  if (typeof data.pgn !== 'string' || !data.pgn.trim()) throw new Error('the import link has no PGN');
  if (data.pgn.length > MAX_IMPORT_PGN) throw new Error('the PGN is too large');
  return {
    source,
    pgn: data.pgn,
    user: typeof data.user === 'string' && data.user ? data.user : undefined,
    url: typeof data.url === 'string' && /^https:\/\/(www\.)?chess\.com\//.test(data.url) ? data.url : undefined,
  };
}
