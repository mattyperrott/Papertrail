import type { SourcePosition } from '../../shared/types.js';
import type { ExecutableQuote, ExecutionContext } from '../paperExecution.js';
import { asArray, asRecord, fetchJson } from '../lib/http.js';

const finite = (value: unknown) => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));

/** Public market-channel cache. A delta is accepted only after a full snapshot;
 * REST hashes validate/recover it whenever quotes are requested. */
export class MarketBookStream {
  private socket?:WebSocket;
  private ping?:NodeJS.Timeout;
  private reconnect?:NodeJS.Timeout;
  private attempts=0;
  private stopped=false;
  private subscribed=new Set<string>();
  private books=new Map<string,Record<string,unknown>>();
  connected=false;
  private lastContactAt=0;
  /** How current a cached channel book is: now while the socket is up (deltas
   * arrive as they happen), otherwise the moment contact was lost. */
  freshAsOf(now=Date.now()){return this.connected?now:this.lastContactAt;}

  ensure(assets:string[]) {
    const fresh=assets.filter(asset=>asset&&!this.subscribed.has(asset));
    for(const asset of fresh)this.subscribed.add(asset);
    if(!this.socket||this.socket.readyState===WebSocket.CLOSED)this.connect();
    else if(this.socket.readyState===WebSocket.OPEN&&fresh.length)this.socket.send(JSON.stringify({operation:'subscribe',assets_ids:fresh}));
  }
  book(asset:string){return this.books.get(asset);}
  replace(asset:string,book:Record<string,unknown>){this.books.set(asset,book);}
  /** REST says the book no longer exists (ended market): a cached snapshot is
   * not a fallback for that, it is stale inventory to stop quoting from. */
  forget(asset:string){this.books.delete(asset);}

  private connect() {
    if(this.stopped||!this.subscribed.size||this.socket&&(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING))return;
    const socket=this.socket=new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    socket.addEventListener('open',()=>{this.connected=true;this.attempts=0;socket.send(JSON.stringify({assets_ids:[...this.subscribed],type:'market'}));this.ping=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('PING');},10_000);});
    socket.addEventListener('message',event=>this.onMessage(String(event.data)));
    const disconnected=()=>{if(this.socket!==socket)return;this.connected=false;this.lastContactAt=Date.now();if(this.ping)clearInterval(this.ping);this.socket=undefined;if(!this.stopped){const delay=Math.min(60_000,1000*2**Math.min(6,this.attempts++));this.reconnect=setTimeout(()=>this.connect(),delay+Math.floor(Math.random()*delay/2));}};
    socket.addEventListener('close',disconnected);socket.addEventListener('error',()=>socket.close());
  }
  private onMessage(text:string) {
    this.lastContactAt=Date.now();
    if(text==='PONG'||text==='PING')return;
    let value:unknown;try{value=JSON.parse(text);}catch{return;}
    for(const message of (Array.isArray(value)?value:[value]).map(asRecord)) {
      const type=String(message.event_type??'');
      if(type==='book') {
        // A channel snapshot carries no min_order_size (and not always a tick
        // size), so on its own it can never pass quote validation. Keep those
        // from the last REST book: they are market constants, not book state.
        const asset=String(message.asset_id??'');if(!asset)continue;
        const prior=this.books.get(asset);
        this.books.set(asset,{...message,tick_size:message.tick_size??prior?.tick_size,min_order_size:message.min_order_size??prior?.min_order_size});
      } else if(type==='price_change') {
        const timestamp=Number(message.timestamp);
        for(const change of asArray(message.price_changes).map(asRecord)) {
          const asset=String(change.asset_id??''),current=this.books.get(asset);if(!current)continue;
          if(Number(current.timestamp)>timestamp)continue;
          const side=String(change.side)==='BUY'?'bids':'asks';
          const levels=asArray(current[side]).map(asRecord).filter(level=>String(level.price)!==String(change.price));
          if(Number(change.size)>0)levels.push({price:String(change.price),size:String(change.size)});
          this.books.set(asset,{...current,[side]:levels,timestamp:String(timestamp),hash:String(change.hash??current.hash??'')});
        }
      } else if(type==='tick_size_change') {
        const asset=String(message.asset_id??''),current=this.books.get(asset);if(current)this.books.set(asset,{...current,tick_size:String(message.new_tick_size),timestamp:String(message.timestamp??current.timestamp)});
      }
    }
  }
  close(){this.stopped=true;if(this.ping)clearInterval(this.ping);if(this.reconnect)clearTimeout(this.reconnect);this.socket?.close();this.socket=undefined;this.connected=false;}
}

/** Public, read-only snapshots. No wallet, signer, allowance or order submission code. */
/** `capturedAt` is when the snapshot was obtained: `now` for a REST response, the
 * stream's last-contact time for a cached channel book. The CLOB `timestamp` is
 * the book's last *change*, not its age: a market that has not traded for an
 * hour still has a live, executable book. Treating that timestamp as the
 * capture time labelled most quiet markets stale and silently dropped them from
 * every deploy cycle. It is kept as `bookUpdatedAt` for depth-consumption
 * tracking and still must not sit in the future. */
export function parseExecutionQuote(book: Record<string, unknown>, market: Record<string, unknown>, asset: string, now = Date.now(), capturedAt = now): ExecutableQuote {
  if (book.asset_id !== asset || market.active !== true || market.closed !== false || market.acceptingOrders !== true) {
    throw new Error('Market is not accepting orders or book asset mismatch');
  }
  const levels = (raw: unknown) => asArray(raw).map(asRecord).map(level => {
    if (!finite(level.price) || !finite(level.size)) throw new Error('Invalid book level');
    const price = Number(level.price), size = Number(level.size);
    if (price <= 0 || price >= 1 || size <= 0) throw new Error('Invalid book level');
    return { price, size };
  });
  const bids = levels(book.bids).sort((a,b) => b.price-a.price);
  const asks = levels(book.asks).sort((a,b) => a.price-b.price);
  if (bids.length && asks.length && bids[0].price >= asks[0].price) throw new Error('Crossed order book');
  const schedule = asRecord(market.feeSchedule);
  const feeRate = market.feesEnabled === false ? 0 : market.feesEnabled === true && finite(schedule.rate) ? Number(schedule.rate) : NaN;
  const feeExponent = market.feesEnabled === false ? 1 : finite(schedule.exponent) ? Number(schedule.exponent) : NaN;
  const tickSize = finite(book.tick_size) ? Number(book.tick_size) : NaN;
  const minOrderShares = finite(book.min_order_size) ? Number(book.min_order_size) : NaN;
  // The CLOB book timestamp is epoch milliseconds.
  const bookUpdatedAt = finite(book.timestamp) ? Number(book.timestamp) : NaN;
  if (!(feeRate >= 0 && feeRate <= 1 && feeExponent > 0 && feeExponent <= 5 && tickSize > 0 && tickSize < 1 && minOrderShares > 0 && bookUpdatedAt > 0 && bookUpdatedAt <= now + 5_000 && capturedAt > 0 && capturedAt <= now + 1_000)) {
    throw new Error('Unknown or invalid fee, tick, minimum size or book timestamp');
  }
  return { asset, capturedAt: Math.min(now, capturedAt), bookUpdatedAt: Math.min(now, bookUpdatedAt), bids, asks, tickSize, minOrderShares, feeRate, feeExponent };
}

/** Gamma omits closed markets from a `condition_ids` lookup unless asked for
 * them, so a market that resolved since the signal arrived read as "metadata
 * missing" rather than as closed. Ask again with `closed=true` before giving up. */
async function fetchMarket(conditionId: string, getJson: JsonFetcher): Promise<Record<string, unknown>> {
  for (const closed of [undefined, 'true']) {
    const params = new URLSearchParams({condition_ids: conditionId});
    if (closed) params.set('closed', closed);
    const raw = await getJson<unknown>(`https://gamma-api.polymarket.com/markets?${params}`);
    const market = asArray(raw).map(asRecord).find(m => String(m.conditionId).toLowerCase() === conditionId.toLowerCase());
    if (market) return market;
  }
  throw new Error('Market metadata missing');
}

type JsonFetcher = <T>(url: string) => Promise<T>;
/** The subset of MarketBookStream the quote source touches; tests inject a stub. */
interface BookStream { ensure(assets: string[]): void; book(asset: string): Record<string, unknown> | undefined; replace(asset: string, book: Record<string, unknown>): void; forget(asset: string): void; freshAsOf(now?: number): number; connected: boolean; close(): void; }

export interface UnavailableQuote { asset: string; reason: string; }

/** "12 Request timed out from clob.polymarket.com; 3 Market is closed…" — the
 * top reasons from the last fetch, so the dashboard banner says why fills were
 * blocked instead of only how many. */
export function summarizeUnavailable(rows: UnavailableQuote[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, limit).map(([reason, count]) => `${count} ${reason}`);
  const rest = ranked.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  if (rest) shown.push(`${rest} other`);
  return shown.join('; ');
}

export class ExecutionQuoteSource {
  private readonly stream: BookStream;
  private readonly getJson: JsonFetcher;
  constructor(options: {fetchJson?: JsonFetcher; stream?: BookStream} = {}) {
    this.getJson = options.fetchJson ?? fetchJson;
    this.stream = options.stream ?? new MarketBookStream();
  }
  async fetch(assets: Array<{asset:string;conditionId:string}>, sourcePositionsAsOf = Date.now()): Promise<ExecutionContext> {
    const unique = [...new Map(assets.filter(p => p.asset && p.conditionId).map(p => [p.asset,p])).values()];
    this.stream.ensure(unique.map(row=>row.asset));
    const quotes: Record<string, ExecutableQuote> = {};
    const markets = new Map<string, Promise<Record<string, unknown>>>();
    const errors: UnavailableQuote[] = [];
    let cursor = 0;
    await Promise.all(Array.from({length: Math.min(4,unique.length)}, async () => {
      while (cursor < unique.length) {
        const {asset,conditionId} = unique[cursor++];
        try {
          if (!markets.has(conditionId)) markets.set(conditionId, fetchMarket(conditionId, this.getJson));
          const [market,rest] = await Promise.all([
            markets.get(conditionId)!,
            this.getJson<unknown>(`https://clob.polymarket.com/book?${new URLSearchParams({token_id:asset})}`).then(raw => ({book: asRecord(raw)})).catch((error: unknown) => ({error})),
          ]);
          // Checked before the book so a closed market reads as closed, not as a 404.
          if (market.active !== true || market.closed !== false || market.acceptingOrders !== true) throw new Error('Market is closed or not accepting orders');
          const restBook = 'book' in rest ? rest.book : undefined;
          const restError = 'error' in rest ? messageOf(rest.error) : '';
          // The stream covers a rate-limited or timed-out REST read, not a
          // definitive "no orderbook exists" for a market that has ended.
          if (/HTTP 404/.test(restError)) { this.stream.forget(asset); throw new Error('No order book (market ended or delisted)'); }
          // REST wins whenever it answered; the channel cache only covers a
          // failed read. Preferring the cached copy on a matching hash quoted a
          // snapshot that had arrived before any REST book and so carried no
          // min_order_size, which failed validation for exactly the markets
          // whose books had not changed: the long-running "N quotes unavailable".
          const book=restBook??this.stream.book(asset);
          if(!book)throw new Error(`No order book (${restError || 'no REST or WebSocket book'})`);
          if(restBook)this.stream.replace(asset,restBook);
          const now=Date.now();
          quotes[asset] = parseExecutionQuote(book, market, asset, now, restBook ? now : this.stream.freshAsOf(now));
        } catch (error) {
          errors.push({asset, reason: messageOf(error)});
        }
      }
    }));
    // Missing assets remain absent, so the engine records a rejected or pending decision.
    this.lastUnavailable = errors;
    this.lastUnavailableCount = errors.length;
    return { quotes, sourcePositionsAsOf, consumed: {} };
  }
  lastUnavailableCount = 0;
  lastUnavailable: UnavailableQuote[] = [];
  get streamConnected(){return this.stream.connected;}
  close(){this.stream.close();}
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function stampSourcePositions(positions: SourcePosition[], now = Date.now()) {
  return positions.map(position => ({...position, observedAt: new Date(now).toISOString()}));
}
