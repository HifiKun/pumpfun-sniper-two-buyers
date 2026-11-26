# pumpfun-sniper-two-buyers

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/HifiKun/pumpfun-sniper-two-buyers/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/HifiKun/pumpfun-sniper-two-buyers/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A pump.fun launch sniper for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a 24h pump.fun replay: it buys a fresh launch only in its first 3 slots, only when the opening tape looks clean (real SOL ≥ 2, creator's own buy ≤ 0.5 SOL, creator hasn't sold, exactly 2 distinct early buyers — a launch bundled by many wallets is a dump waiting to happen), then exits mechanically at +30% take-profit, −3% stop-loss, a trailing stop, or after 100 slots, and pyramids one extra 0.08 SOL into a runner that keeps climbing.

Local dev-window backtest (kit's frozen dev data, all three parts): **+0.1375 SOL net PnL**, 29 coins, 63 fills, max drawdown 0.48%.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol over stdin/stdout (see `vendor/makefun-bot.ts`); the grader runs it as `node main.ts` on Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6a1ay90r&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
