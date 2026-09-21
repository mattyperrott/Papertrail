import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePolymarketScanProfile, PolymarketScanVerifier } from './polymarketScan.js';

test('parses verification metrics and detects conflicting win-rate text', () => {
  const html = `
    <dl>
      <dt>All-time P&amp;L</dt><dd>+$125,000</dd>
      <dt>Total Trades</dt><dd>250</dd>
      <dt>Win Rate</dt><dd>99.0% (60W / 40L settled)</dd>
      <dt>Volume</dt><dd>$1,500,000</dd>
      <dt>ROI</dt><dd>+18.5%</dd>
      <dt>Sharpe Ratio</dt><dd>1.42</dd>
      <dt>Active For</dt><dd>420 days</dd>
    </dl>`;
  const result = parsePolymarketScanProfile(html, '0x0000000000000000000000000000000000000001');
  assert.equal(result.pnl, 125000);
  assert.equal(result.roi, 18.5);
  assert.equal(result.winRate, 60);
  assert.equal(result.status, 'warning');
  assert.match(result.notes[0], /conflicts/i);
});

test('accepts internally consistent PolymarketScan evidence', () => {
  const html = `
    <dl>
      <dt>All-time P&amp;L</dt><dd>+$10,000</dd>
      <dt>Total Trades</dt><dd>100</dd>
      <dt>Win Rate</dt><dd>60.0% (60W / 40L settled)</dd>
      <dt>Volume</dt><dd>$90,000</dd><dt>ROI</dt><dd>+11.1%</dd>
    </dl>`;
  const result = parsePolymarketScanProfile(html, '0x0000000000000000000000000000000000000001');
  assert.equal(result.status, 'verified');
  assert.equal(result.winRate, 60);
});

test('preserves signed financial abbreviations and treats placeholders as missing', async () => {
  const { parseProfileNumber } = await import('./polymarketScan.js');
  assert.equal(parseProfileNumber('$1.25M'), 1250000);
  assert.equal(parseProfileNumber('($12.5K)'), -12500);
  assert.equal(parseProfileNumber('−$1,234.50'), -1234.5);
  assert.equal(parseProfileNumber('$-125'), -125);
  assert.equal(parseProfileNumber('—'), undefined);
  assert.equal(parseProfileNumber('N/A'), undefined);
  assert.equal(parseProfileNumber(''), undefined);
  assert.equal(parseProfileNumber('$12,34'), undefined);
  assert.equal(parseProfileNumber('$1.2.3'), undefined);
  assert.equal(parseProfileNumber('$1,000 (estimated 25)'), undefined);
});

test('always derives exact ratio, rejecting discrepancies beyond displayed rounding', () => {
  const html = `<dl><dt>All-time P&amp;L</dt><dd>$100</dd><dt>ROI</dt><dd>5%</dd>
    <dt>Win Rate</dt><dd>61.0% (60W / 40L)</dd></dl>`;
  const result = parsePolymarketScanProfile(html, 'wallet');
  assert.equal(result.winRate, 60);
  assert.equal(result.status, 'warning');
});

test('missing settled denominator never qualifies a displayed percentage', () => {
  const html = `<dl><dt>All-time P&amp;L</dt><dd>$100</dd><dt>ROI</dt><dd>5%</dd>
    <dt>Win Rate</dt><dd>99.9%</dd></dl>`;
  const result = parsePolymarketScanProfile(html, 'wallet');
  assert.equal(result.winRate, undefined);
  assert.equal(result.status, 'unavailable');
});

test('zero settled denominator and conflicting repeated fields fail closed', () => {
  const html = `<dl><dt>All-time P&amp;L</dt><dd>$100</dd><dt>ROI</dt><dd>5%</dd>
    <dt>ROI</dt><dd>10%</dd><dt>Win Rate</dt><dd>100% (0W / 0L)</dd></dl>`;
  const result = parsePolymarketScanProfile(html, 'wallet');
  assert.equal(result.roi, undefined);
  assert.equal(result.status, 'unavailable');
});

test('verification is cached across scans and a failure expires quickly', async () => {
  const verifier = new PolymarketScanVerifier();
  const now = Date.parse('2026-09-09T00:00:00Z');
  // The network is unreachable in tests, so every fetch fails; that still proves
  // the cache path, since an uncached call always increments `fetched`.
  const first = await verifier.verify('0x1', now);
  assert.equal(verifier.fetched, 1);
  const second = await verifier.verify('0x1', now + 60_000);
  assert.equal(verifier.fetched, 1, 'inside the negative TTL, no second request');
  assert.equal(verifier.served, 1);
  assert.equal(second.checkedAt, first.checkedAt, 'a cache hit must not restamp checkedAt as fresh');
  await verifier.verify('0x1', now + 6 * 60_000);
  assert.equal(verifier.fetched, 2, 'an unavailable result expires in minutes, not hours');
  await verifier.verify('0X1', now + 6 * 60_000);
  assert.equal(verifier.fetched, 2, 'address matching is case insensitive');
});
