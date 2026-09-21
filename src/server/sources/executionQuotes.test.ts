import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionQuoteSource, parseExecutionQuote, summarizeUnavailable } from './executionQuotes.js';
const now = Date.now();
const book = { asset_id:'a', timestamp:String(now), tick_size:'.01',min_order_size:'5',bids:[{price:'.49',size:'10'}],asks:[{price:'.51',size:'20'}]};
const market = {active:true,closed:false,acceptingOrders:true,feesEnabled:true,feeSchedule:{rate:.05,exponent:1}};
test('quote parses actual depth, timestamp and market fee schedule', () => {
  const quote = parseExecutionQuote(book,market,'a',now);
  assert.equal(quote.feeRate,.05);
  assert.equal(quote.asks[0].price,.51);
  assert.equal(quote.capturedAt,now);
});
test('quotes fail closed on unknown fees, closed markets, wrong asset, NaN and crossed books', () => {
  for (const altered of [{...market,feesEnabled:undefined},{...market,closed:true},{...market,feeSchedule:{rate:NaN,exponent:1}}]) assert.throws(()=>parseExecutionQuote(book,altered,'a',now));
  assert.throws(()=>parseExecutionQuote(book,market,'b',now));
  assert.throws(()=>parseExecutionQuote({...book,bids:[{price:'.52',size:'1'}]},market,'a',now));
  assert.throws(()=>parseExecutionQuote({...book,timestamp:undefined},market,'a',now));
});
test('unavailable summary ranks reasons and folds the tail into "other"', () => {
  const rows = [
    ...Array.from({length: 3}, (_, i) => ({asset: `t${i}`, reason: 'Request timed out from clob.polymarket.com'})),
    {asset: 'c1', reason: 'Market is closed or not accepting orders'}, {asset: 'c2', reason: 'Market is closed or not accepting orders'},
    {asset: 'm', reason: 'Market metadata missing'}, {asset: 'x', reason: 'Crossed order book'},
  ];
  assert.equal(summarizeUnavailable(rows), '3 Request timed out from clob.polymarket.com; 2 Market is closed or not accepting orders; 1 Market metadata missing; 1 other');
  assert.equal(summarizeUnavailable([]), '');
});
test('quote source records why each asset was unavailable and retries closed markets', async () => {
  const calls: string[] = [];
  const closedMarket = {conditionId: '0xc', active: true, closed: true, acceptingOrders: false};
  const fetchJson = async <T,>(url: string): Promise<T> => {
    calls.push(url);
    if (url.includes('condition_ids=0xc') && url.includes('closed=true')) return [closedMarket] as T;
    if (url.includes('condition_ids=0xc')) return [] as T;
    if (url.includes('condition_ids=0xa')) return [{...market, conditionId: '0xa'}] as T;
    if (url.includes('token_id=a')) return book as T;
    throw new Error('HTTP 404 from clob.polymarket.com');
  };
  const source = new ExecutionQuoteSource({fetchJson, stream: {ensure() {}, book() { return undefined; }, replace() {}, forget() {}, freshAsOf() { return 0; }, connected: false, close() {}}});
  const context = await source.fetch([{asset: 'a', conditionId: '0xa'}, {asset: 'c', conditionId: '0xc'}, {asset: 'z', conditionId: '0xa'}]);
  assert.equal(context.quotes!.a.asks[0].price, .51);
  assert.equal(source.lastUnavailableCount, 2);
  assert.deepEqual(source.lastUnavailable.map(r => r.reason).sort(), ['Market is closed or not accepting orders', 'No order book (market ended or delisted)']);
  assert.ok(calls.some(url => url.includes('condition_ids=0xc') && url.includes('closed=true')));
});
test('a websocket snapshot keeps the REST book\'s market constants and can back a rate-limited REST read', async () => {
  const {MarketBookStream} = await import('./executionQuotes.js');
  const stream = new MarketBookStream();
  const receive = (value: unknown) => (stream as unknown as {onMessage: (text: string) => void}).onMessage(JSON.stringify(value));
  stream.replace('a', book);
  receive({event_type: 'book', asset_id: 'a', timestamp: String(now), hash: 'h1', bids: [{price: '.48', size: '3'}], asks: [{price: '.52', size: '4'}]});
  assert.equal(stream.book('a')!.min_order_size, '5', 'min_order_size survives the snapshot');
  const fetchJson = async <T,>(url: string): Promise<T> => {
    if (url.includes('condition_ids=0xa')) return [{...market, conditionId: '0xa'}] as T;
    throw new Error('HTTP 429 from clob.polymarket.com');
  };
  const source = new ExecutionQuoteSource({fetchJson, stream});
  const context = await source.fetch([{asset: 'a', conditionId: '0xa'}]);
  assert.equal(context.quotes!.a.bids[0].price, .48, 'the stream backed the failed REST read');
  assert.equal(source.lastUnavailableCount, 0);
  stream.close();
});
test('a live REST snapshot of a quiet book is fresh; its last-change time only keys depth consumption', () => {
  const quiet = parseExecutionQuote({...book, timestamp: String(now - 3_600_000)}, market, 'a', now);
  assert.equal(quiet.capturedAt, now);
  assert.equal(quiet.bookUpdatedAt, now - 3_600_000);
  assert.throws(() => parseExecutionQuote({...book, timestamp: String(now + 60_000)}, market, 'a', now), /book timestamp/);
  assert.throws(() => parseExecutionQuote(book, market, 'a', now, 0), /book timestamp/, 'a stream that never connected has no capture time');
});
test('a channel snapshot that arrived before any REST book never displaces a REST answer', async () => {
  const {MarketBookStream} = await import('./executionQuotes.js');
  const stream = new MarketBookStream();
  const receive = (value: unknown) => (stream as unknown as {onMessage: (text: string) => void}).onMessage(JSON.stringify(value));
  // Subscribed first, so the snapshot lands with no constants to inherit; it shares the REST hash.
  receive({event_type: 'book', asset_id: 'a', timestamp: String(now), hash: 'same', bids: book.bids, asks: book.asks});
  const fetchJson = async <T,>(url: string): Promise<T> => {
    if (url.includes('condition_ids=0xa')) return [{...market, conditionId: '0xa'}] as T;
    return {...book, hash: 'same'} as T;
  };
  const source = new ExecutionQuoteSource({fetchJson, stream});
  const context = await source.fetch([{asset: 'a', conditionId: '0xa'}]);
  assert.equal(source.lastUnavailableCount, 0, source.lastUnavailable.map(r => r.reason).join());
  assert.equal(context.quotes!.a.minOrderShares, 5);
  stream.close();
});
