// Fresh-launch sniper for the agent-fun/replay/v2 pump.fun replay.
//
// Idea: most pump.fun coins die within minutes of launch, but a small share run
// hard in their first slots. The bot only buys a coin in its opening slots, and
// only when the opening tape looks clean: the creator did not load up a huge
// personal bag, did not sell, only a handful of other wallets bought in the
// first slot (a launch bundled by dozens of wallets is a dump waiting to
// happen), nobody dumped a large chunk, and fresh SOL is still flowing in.
// Every position is small, exits are mechanical — take profit, cut the loss,
// trail a runner, never hold past a short deadline — so one bad coin can only
// cost its stake plus fees.
//
// Deterministic by construction: a pure function of the hello message and the
// batches it is fed. No clock, no randomness, no I/O, iteration only over
// insertion-ordered maps.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Buy at most this many slots after the CreateEvent. */
  entryAgeMax: number;
  /** Lamports aimed at per coin (each buy still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time. */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buys in the create slot: at most this. */
  maxDevBuyLamports: number;
  /** Distinct non-creator buyers seen before entry: at most this. */
  maxEarlyBuyers: number;
  /** Distinct non-creator buyers seen before entry: at least this. */
  minEarlyBuyers: number;
  /** Trades seen before entry: at least this. */
  minEarlyTrades: number;
  /** Lamports sold by others / lamports bought, in bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell, in bps of real SOL before it, at most. */
  maxBigSellBps: number;
  /** Price now / create price, in bps: entry window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window in slots, and the net inflow it must show. */
  flowWindowSlots: number;
  minFlowLamports: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys, in bps. */
  buySlippageBps: number;
  /** Sell this share of the position (bps) at the first take-profit. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, stop out this far under cost (bps). */
  stopAfterTp1Bps: number;
  /** Sell everything once the position is worth this much over cost (bps). */
  takeProfitBps: number;
  /** Sell everything once the position is worth this much under cost (bps). */
  stopLossBps: number;
  /** Trailing stop: once up this far, sell on a fall of this much from the best value (bps). */
  trailArmBps: number;
  trailDropBps: number;
  /** Sell after holding this many slots. */
  maxHoldSlots: number;
  /** Sell at once when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Sell when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Extra buys into a running position: at most this many, each this far above the last buy. */
  maxAdds: number;
  addStepBps: number;
  addDelaySlots: number;
  addLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  entryAgeMax: 3,
  stakeLamports: 160_000_000,
  minBuyLamports: 5_000_000,
  minRealSolLamports: 2_000_000_000,
  maxRealSolLamports: 30_000_000_000,
  maxDevBuyLamports: 500_000_000,
  maxEarlyBuyers: 2,
  minEarlyBuyers: 2,
  minEarlyTrades: 0,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindowSlots: 10,
  minFlowLamports: -1_000_000_000_000,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  stopAfterTp1Bps: 0,
  takeProfitBps: 3_000,
  stopLossBps: 300,
  trailArmBps: 2_000,
  trailDropBps: 300,
  maxHoldSlots: 100,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  maxAdds: 1,
  addStepBps: 500,
  addDelaySlots: 4,
  addLamports: 80_000_000,
};

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  createVq: bigint;
  createVt: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: TapeTick[];
  boughtOnce: boolean;
  spent: bigint;
  /** Decision price (vq/vt) of the last buy sent, for add-on steps. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  buysSent: number;
  /** Never touch again (exited, filtered out for good, completed). */
  closed: boolean;
  complete: boolean;
}

interface OpenPosition {
  openedSlot: number;
  feesPaid: bigint;
  bestValue: bigint;
  devSoldAtOpen: boolean;
  tookPartial: boolean;
}

/** Curve fees charged on a sell: protocol 95 bps + creator 30 bps. */
const SELL_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) nets after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * SELL_FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const coins = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, OpenPosition>();
  const selling = new Set<Pubkey>();
  const stake = BigInt(p.stakeLamports);
  const minBuy = BigInt(p.minBuyLamports);

  function absorb(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          spent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          buysSent: 0,
          closed: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const before = BigInt(e.real_quote_reserves) + sol;
          if (before > 0n) {
            const bps = (sol * BPS) / before;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.closed = true;
        }
      }
    }
  }

  /** Net SOL flow and distinct buyers over the last flowWindowSlots slots. */
  function recentFlow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - p.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      absorb(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Track fills: a filled buy opens a position record; a fill for a mint we
      // no longer hold clears its record.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy' && !open.has(f.mint)) {
          open.set(f.mint, {
            openedSlot: f.slot,
            feesPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookPartial: false,
          });
        }
        const rec = open.get(f.mint);
        if (rec !== undefined && f.status !== 'rejected') rec.feesPaid += BigInt(f.tx_fee_lamports);
      }
      for (const mint of [...selling]) {
        if (!pendingSide(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingSide(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      // --- Exits first, so a slot freed by a sale can be reused in this batch. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let rec = open.get(mint);
        if (rec === undefined) {
          rec = { openedSlot: state.slot, feesPaid: txFee, bestValue: 0n, devSoldAtOpen: c?.devSold ?? false, tookPartial: false };
          open.set(mint, rec);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - txFee;
        const basis = pos.cost_lamports + rec.feesPaid;
        if (value > rec.bestValue) rec.bestValue = value;

        let exit = false;
        if (basis > 0n) {
          // First take-profit: sell part, let the rest run with a breakeven stop.
          if (!rec.tookPartial && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
            const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              rec.tookPartial = true;
              rec.bestValue = 0n;
              if (c !== undefined) c.closed = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(p.takeProfitBps))) exit = true;
          const stop = rec.tookPartial ? BigInt(p.stopAfterTp1Bps) : BigInt(p.stopLossBps);
          if (value * BPS <= basis * (BPS - stop)) exit = true;
          if (
            rec.bestValue * BPS >= basis * (BPS + BigInt(p.trailArmBps)) &&
            value * BPS <= rec.bestValue * (BPS - BigInt(p.trailDropBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - rec.openedSlot >= p.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !rec.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.closed = true;
      }

      // --- Entries and add-ons: one fresh coin per batch at most, while a slot is free. ---
      let cash = state.freeCashLamports() - txFee * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.closed || c.complete) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // Add-on: pyramid into a runner while the price keeps climbing.
        if (c.boughtOnce) {
          if (c.buysSent > p.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || pendingSide(state, c.mint, 'buy')) continue;
          if (state.slot - c.lastBuySlot < p.addDelaySlots) continue;
          const up = (curve.virtual_quote_reserves * c.lastBuyVt * BPS) / (curve.virtual_token_reserves * c.lastBuyVq);
          if (up < BPS + BigInt(p.addStepBps)) continue;
          if (recentFlow(c, state.slot).net < 0n) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const want = BigInt(p.addLamports);
          const addAmount = want < maxAdd ? want : maxAdd;
          if (addAmount < minBuy || cash < addAmount + txFee) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: addAmount, max_slippage_bps: p.buySlippageBps });
          cash -= addAmount + txFee;
          c.buysSent += 1;
          c.spent += addAmount;
          c.lastBuyVq = curve.virtual_quote_reserves;
          c.lastBuyVt = curve.virtual_token_reserves;
          c.lastBuySlot = state.slot;
          continue;
        }
        const age = state.slot - c.createSlot;
        if (age > p.entryAgeMax) {
          c.closed = true;
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) continue;
        if (c.devSold && p.skipDevSold) {
          c.closed = true;
          continue;
        }
        // Opening-tape filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSolLamports) || rq > BigInt(p.maxRealSolLamports)) continue;
        if (c.devBuy > BigInt(p.maxDevBuyLamports)) continue;
        if (c.trades < p.minEarlyTrades || c.buyers.size < p.minEarlyBuyers || c.buyers.size > p.maxEarlyBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const runup = (curve.virtual_quote_reserves * c.createVt * BPS) / (curve.virtual_token_reserves * c.createVq);
        if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) continue;
        if (recentFlow(c, state.slot).net < BigInt(p.minFlowLamports)) continue;
        const room = stake - c.spent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (cash < amount + txFee) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        cash -= amount + txFee;
        c.boughtOnce = true;
        c.buysSent = 1;
        c.spent += amount;
        c.lastBuyVq = curve.virtual_quote_reserves;
        c.lastBuyVt = curve.virtual_token_reserves;
        c.lastBuySlot = state.slot;
        openCount += 1;
      }
      return orders;
    },
  };
}
