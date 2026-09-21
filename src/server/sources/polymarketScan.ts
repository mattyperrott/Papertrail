import type { VerificationEvidence } from '../../shared/types.js';
import { fetchText } from '../lib/http.js';

const decode = (value: string) => value
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&minus;|&#8722;|−/g, '-').replace(/\s+/g, ' ').trim();

/** Strict numeric text with an optional financial suffix. Placeholder dashes and
 * markup cannot silently turn into zero; $1.2M must not become $1.20.
 */
export function parseProfileNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const normalized = decode(value).trim();
  const match = normalized.match(/^(\()?\s*([+-])?\s*\$?\s*([+-])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*([KMBT])?\s*%?\s*(\))?$/i);
  if (!match || Boolean(match[1]) !== Boolean(match[6]) || (match[2] && match[3])) return undefined;
  const multiplier: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const magnitude = Number(match[4].replaceAll(',', '')) * (multiplier[match[5]?.toUpperCase()] ?? 1);
  const negative = Boolean(match[1]) || match[2] === '-' || match[3] === '-';
  return Number.isFinite(magnitude) ? (negative ? -magnitude : magnitude) : undefined;
}

const profileFields = (html: string): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = decode(match[1]).toLowerCase();
    // Duplicated conflicting labels make a summary ambiguous. An empty string is
    // deliberately unparseable and fails closed instead of choosing one value.
    const value = decode(match[2]);
    fields.set(label, fields.has(label) && fields.get(label) !== value ? '' : value);
  }
  return fields;
};

export function parsePolymarketScanProfile(html: string, address: string): VerificationEvidence {
  const notes: string[] = [];
  const fields = profileFields(html);
  const rawWinRate = fields.get('win rate');
  const reportedWinRate = parseProfileNumber(rawWinRate?.match(/([+-]?[\d.]+)\s*%/)?.[1]);
  const counts = rawWinRate?.match(/(?:^|[\s(])([\d,]+)W\s*\/\s*([\d,]+)L(?:\b|$)/i);
  const wins = counts ? Number(counts[1].replaceAll(',', '')) : undefined;
  const losses = counts ? Number(counts[2].replaceAll(',', '')) : undefined;
  const validCounts = wins !== undefined && losses !== undefined && Number.isSafeInteger(wins)
    && Number.isSafeInteger(losses) && wins >= 0 && losses >= 0 && Number.isSafeInteger(wins + losses) && wins + losses > 0;
  const settledWinRate = validCounts ? wins / (wins + losses) * 100 : undefined;
  // Every percentage and denominator must agree, including small discrepancies;
  // allow only the rounding precision visibly reported by the page.
  const decimalPlaces = rawWinRate?.match(/\d+(?:\.(\d+))?\s*%/)?.[1]?.length ?? 0;
  const roundingTolerance = 0.5 * 10 ** -decimalPlaces + 1e-9;
  if (reportedWinRate !== undefined && settledWinRate !== undefined && Math.abs(reportedWinRate - settledWinRate) > roundingTolerance) {
    notes.push('Displayed win rate conflicts with settled W/L counts; using the settled ratio.');
  }
  if (!validCounts) notes.push('A positive settled W/L sample is missing or invalid.');
  if (reportedWinRate !== undefined && (reportedWinRate < 0 || reportedWinRate > 100)) notes.push('Displayed win rate is outside 0-100%.');

  const pnl = parseProfileNumber(fields.get('all-time p&l'));
  const roi = parseProfileNumber(fields.get('roi'));
  const volume = parseProfileNumber(fields.get('volume'));
  const sharpe = parseProfileNumber(fields.get('sharpe ratio'));
  const rawActive = fields.get('active for');
  const activeDays = rawActive?.match(/^([\d,]+)\s*days?$/i)
    ? parseProfileNumber(rawActive.replace(/\s*days?$/i, '')) : undefined;
  const totalTrades = parseProfileNumber(fields.get('total trades'));
  const winRate = settledWinRate;
  if (pnl === undefined || roi === undefined || winRate === undefined) notes.push('One or more core verification metrics were missing.');
  if (roi !== undefined && roi < -100) notes.push('Reported ROI is below the unlevered loss limit.');
  if (volume !== undefined && volume < 0) notes.push('Reported trading volume is negative.');
  if (totalTrades !== undefined && (!Number.isSafeInteger(totalTrades) || totalTrades < 0)) notes.push('Reported trade count is invalid.');
  if (totalTrades !== undefined && validCounts && totalTrades < wins + losses) notes.push('Trade count is lower than settled outcome count; treat the profile metrics as inconsistent.');
  const status = pnl !== undefined && roi !== undefined && winRate !== undefined
    ? notes.length === 0 ? 'verified' : 'warning' : 'unavailable';
  notes.push('Third-party summary consistency only; ROI basis, fees, capital flows, leverage and independent outcome counts are not audited.');
  return {
    provider: 'polymarketscan', checkedAt: new Date().toISOString(),
    url: `https://polymarketscan.org/address/${address}`, status,
    pnl, roi, winRate, wins: validCounts ? wins : undefined, losses: validCounts ? losses : undefined,
    volume, sharpe, activeDays, notes,
  };
}

/** All-time profile totals move slowly, so re-fetching every wallet on every
 * seven-minute scan spends roughly a thousand requests an hour to learn nothing.
 * A failure is cached far more briefly, so a broken endpoint is not hammered but
 * recovery is still quick. */
const VERIFIED_TTL_MS = 6 * 3_600_000;
const UNAVAILABLE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 2000;

export class PolymarketScanVerifier {
  private readonly cache = new Map<string, { expiresAt: number; evidence: VerificationEvidence }>();
  /** Requests actually sent upstream, for scan reporting. */
  fetched = 0;
  served = 0;

  async verify(address: string, now = Date.now()): Promise<VerificationEvidence> {
    const key = address.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.served += 1;
      // `checkedAt` deliberately keeps the original fetch time. Selection rejects
      // evidence older than 24h, and refreshing the stamp on a cache hit would
      // present stale data as fresh and defeat that check.
      return cached.evidence;
    }
    const url = `https://polymarketscan.org/address/${address}`;
    let evidence: VerificationEvidence;
    try {
      this.fetched += 1;
      evidence = parsePolymarketScanProfile(await fetchText(url, { headers: { Accept: 'text/html' } }), address);
    } catch (error) {
      evidence = { provider: 'polymarketscan', checkedAt: new Date(now).toISOString(), url, status: 'unavailable',
        notes: [error instanceof Error ? error.message : 'Verification request failed'] };
    }
    this.remember(key, evidence, now);
    return evidence;
  }

  private remember(key: string, evidence: VerificationEvidence, now: number) {
    if (this.cache.size >= CACHE_LIMIT) {
      for (const [entry, cached] of this.cache) if (cached.expiresAt <= now) this.cache.delete(entry);
      // Insertion order makes the first remaining entry the oldest.
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, {
      evidence,
      expiresAt: now + (evidence.status === 'unavailable' ? UNAVAILABLE_TTL_MS : VERIFIED_TTL_MS),
    });
  }
}
