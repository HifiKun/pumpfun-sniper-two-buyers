// Entry point for the pump.fun replay bot: a fresh-launch sniper with staged
// exits. Run by the grader as `node main.ts`. The strategy lives in
// strategy.ts; the protocol shim is the vendored kit SDK in
// vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
