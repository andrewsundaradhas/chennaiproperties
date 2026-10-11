// Grounding guard for model-written replies. The model may only rephrase the deterministic draft;
// if it introduces any listing code, number or booking claim the draft does not contain, we
// discard the rewrite and send the draft instead.

const CODE_RE = /\b[A-Z]{2,}(?:-[A-Z0-9]+)*-\d{2,}\b/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const BOOKING_CLAIM_RE = /\b(is|are|has been|have been|was|been)\s+(confirmed|booked|scheduled)\b/i;

const digitsSet = (s: string) =>
  new Set((s.match(NUMBER_RE) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, '')));

export function checkGrounded(draft: string, rewrite: string): { ok: true } | { ok: false; reason: string } {
  if (!rewrite.trim()) return { ok: false, reason: 'empty' };
  if (rewrite.length > 1500) return { ok: false, reason: 'too_long' };

  const allowedCodes = new Set(draft.toUpperCase().match(CODE_RE) ?? []);
  for (const code of rewrite.toUpperCase().match(CODE_RE) ?? []) {
    if (!allowedCodes.has(code)) return { ok: false, reason: 'unknown_listing_code' };
  }
  const allowedNumbers = digitsSet(draft);
  for (const n of digitsSet(rewrite)) {
    if (!allowedNumbers.has(n)) return { ok: false, reason: 'unknown_number' };
  }
  if (BOOKING_CLAIM_RE.test(rewrite) && !/\bnot\b[^.]*\b(confirmed|booked)\b/i.test(rewrite)) {
    return { ok: false, reason: 'booking_claim' };
  }
  return { ok: true };
}
