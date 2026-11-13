// The Gavel — autonomous AI bidder bot (NEAR testnet).
// Polls every 4s: opens lots, bids as Mara/Bram/Pip, settles ended lots,
// claims faucet (daily) and income (hourly / when accrued > 20).
// Logs to ~/workspace/gavel/bot.log and stdout. Never crashes the loop.
//
// The bidders have a REAL AI brain: each lot, each bidder asks NEAR AI
// (Claude Haiku via the custom.near-ai helper) what the good is
// worth to them. The AI's maxPrice becomes their valuation for that lot.
// The rules engine (learned multiplier, budget factor, wariness) stays
// as the fallback whenever the AI is unavailable, slow, or returns
// garbage — so the room never goes quiet because the model is down.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { connect, keyStores, KeyPair } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';
const STATE_PATH = '/home/hatch/workspace/gavel/bot-state.json';
const LOG_PATH = '/home/hatch/workspace/gavel/bot.log';
const RPC_URL = 'https://rpc.testnet.fastnear.com';
const GAS = BigInt('30000000000000');
const TICK_MS = 4000;
const AUCTION_DURATION_S = 180;

// NEAR AI: the helper handles the credential securely. Never put a key
// in code, an argument, an env var, or a log. The model is overridable
// with GAVEL_AI_MODEL for testing; the default is Claude Haiku, because
// glm-5.3-flash returns empty content via this connector (verified
// 2026-11-13). Each call costs roughly $0.0004.
const AI_HELPER = '/home/hatch/workspace/custom-connectors/custom.near-ai/bin/near-ai-call.py';
const AI_MODEL = process.env.GAVEL_AI_MODEL || 'anthropic/claude-haiku-4-5';
const AI_TIMEOUT_MS = 15000;
const AI_MAX_TOKENS = 300;
const AI_TEMPERATURE = 0.4;

// Bidders: name, base multiplier (valuation = income/day * mult), base prob/tick, jump.
// The multiplier is only the STARTING point — each bidder learns and their
// multiplier moves with results (see the learning state below). Nothing here
// is fixed for good. The persona is what the AI is told to be.
const BIDDERS = [
  { name: 'Mara', accountId: 'gavel-mara-y08d0h.testnet', baseMultiplier: 12, prob: 0.35, jumpMin: 50, jumpMax: 100, persona: 'aggressive, pushes hard, hates losing' },
  { name: 'Bram', accountId: 'gavel-bram-hag65w.testnet', baseMultiplier: 6, prob: 0.15, jumpMin: 25, jumpMax: 25, persona: 'cautious, patient, waits for value' },
  { name: 'Pip', accountId: 'gavel-pip-76rddq.testnet', baseMultiplier: 8, prob: 0.08, jumpMin: 100, jumpMax: 100, persona: 'careful with money, spends only when it is worth it' },
];
const HOUSE_ID = CONTRACT_ID;

/* ---- Learning state: the economy that evolves on its own ----
   Persisted to bot-state.json so a restart does not wipe what the
   bidders learned. Each bidder carries:
   - multiplier: their current valuation multiple (moves with results).
   - waryOf: { rivalAccountId: times that rival outbid them }.
   - streak: consecutive losses (drives the multiplier up) / wins.
   Rules:
   - Lose a lot you bid on -> multiplier +6% (bid harder next time),
     and note the winner as a rival to be wary of.
   - Win but overpay (payback > 10 days) -> multiplier -8% (you paid
     too much; be more careful). Win at a good price (payback < 6)
     -> multiplier +5% (you can afford to be bolder).
   - Multiplier is clamped to [3, 16] so no one goes wild or gives up.
   - A bidder who is wary of the current leader (outbid by them 3+
     times) bids at half probability and 10% lower valuation against
     that rival — they avoid a fight they keep losing and look for
     another lot instead. */
function defaultLearn(b) { return { multiplier: b.baseMultiplier, waryOf: {}, streak: 0 }; }
function loadLearnState() {
  // File format: { bidders: { accountId: {...} }, drops: { good_id: price } }.
  // Older runs wrote the bidders object directly; read that too.
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const bidders = raw.bidders || raw;
    const drops = raw.drops || {};
    for (const b of BIDDERS) {
      if (!bidders[b.accountId]) bidders[b.accountId] = defaultLearn(b);
      if (typeof bidders[b.accountId].multiplier !== 'number') bidders[b.accountId].multiplier = b.baseMultiplier;
      if (!bidders[b.accountId].waryOf) bidders[b.accountId].waryOf = {};
    }
    return { bidders, drops };
  } catch (e) { const s = {}; for (const b of BIDDERS) s[b.accountId] = defaultLearn(b); return { bidders: s, drops: {} }; }
}
function saveLearnState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify({ bidders: state.learn, drops: state.drops }, null, 2)); } catch (e) { log('STATE SAVE ERROR: ' + e.message.slice(0, 150)); }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) { console.error('log write failed', e.message); }
}

function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

/* ---- Real AI brain (NEAR AI) ----
   askAI asks the model what this lot is worth to this bidder. It calls
   the near-ai helper as a child process (the helper holds the credential;
   this code never sees a key). One call per bidder per lot, cached in
   state.aiPlan. Returns { maxPrice, aggression, line } or null on ANY
   failure (timeout, crash, unparseable output, bad numbers) — the caller
   falls back to the rules engine. Never throws, never blocks the loop. */
function askAI(bidder, lot, ctx) {
  return new Promise((resolve) => {
    const done = (v) => { try { resolve(v); } catch (e) { resolve(null); } };
    let timer = null;
    let child = null;
    try {
      const system = `You are ${bidder.name}, an AI agent bidding in a live auction house. Your personality: ${bidder.persona}. You bid with your own coins for goods that earn income every day. Answer with ONLY a JSON object, no other text.`;
      const user = `Good: ${lot.goodName} (${lot.goodId}), earns ${lot.income}/day. Current bid: ${lot.currentBid}. Time left: ${lot.secsLeft}s. Your balance: ${ctx.balance}. Goods you own: ${ctx.owned.length ? ctx.owned.join(', ') : 'none'}. Your learned valuation is ${ctx.multiplier}x daily income. Recent results: ${ctx.streak}. Rival you are wary of: ${ctx.wary || 'none'}. Current leader: ${lot.leader || 'nobody yet'}. Reply with ONLY this JSON: {"maxPrice": <the most coins you will pay for this good>, "aggression": <0 to 1, how keen you are>, "line": "<a short thought or taunt, under 12 words>"}`;
      const payload = JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: AI_MAX_TOKENS,
        temperature: AI_TEMPERATURE,
      });
      child = spawn('python3', [AI_HELPER, 'complete'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { done(null); return; }
        try {
          const res = JSON.parse(out);
          const text = (res.output || '').trim();
          // The model sometimes wraps the JSON in fences; strip them.
          const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          const plan = JSON.parse(cleaned);
          const maxPrice = Number(plan.maxPrice);
          let aggression = Number(plan.aggression);
          const line = typeof plan.line === 'string' ? plan.line.slice(0, 80) : '';
          if (!Number.isFinite(maxPrice) || maxPrice <= 0) { done(null); return; }
          if (!Number.isFinite(aggression)) aggression = 0.5;
          aggression = Math.max(0, Math.min(1, aggression));
          done({ maxPrice: Math.round(maxPrice), aggression, line });
        } catch (e) { done(null); }
      });
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        done(null);
      }, AI_TIMEOUT_MS);
      child.stdin.on('error', () => { /* helper died early; close handler resolves */ });
      child.stdin.write(payload);
      child.stdin.end();
    } catch (e) {
      if (timer) clearTimeout(timer);
      done(null);
    }
  });
}

/* Kick off one AI plan per bidder for this lot, in the background.
   Called from the tick; it never awaits, so the 4s tick stays fast.
   A plan arrives a few seconds after the lot opens and is then used for
   every later bid on that lot. A bidder who is the seller, is already
   leading, or is broke (balance < 300) gets no call — they cannot bid
   anyway. A failed call is cached as null for this lot so we do not
   retry every tick; the next lot gets a fresh attempt. */
function ensureAIPlans(auction, goods) {
  const good = goods.find(g => g.good_id === auction.good_id);
  if (!good) return;
  const lotId = auction.auction_id;
  if (!state.aiPlan[lotId]) state.aiPlan[lotId] = {};
  const income = Number(good.income_per_day);
  const nowMs = Date.now();
  const secsLeft = Math.max(0, Math.round((Number(auction.ends_at) / 1e6 - nowMs) / 1000));
  for (const b of BIDDERS) {
    if (state.aiPlan[lotId][b.accountId] !== undefined) continue; // already have a plan (or a recorded failure)
    if (state.aiInflight.has(lotId + ':' + b.accountId)) continue;
    if (auction.seller_id === b.accountId) continue;
    if (auction.current_bidder === b.accountId) continue;
    state.aiInflight.add(lotId + ':' + b.accountId);
    balanceOf(b.accountId).then((bal) => {
      if (bal < 300) { state.aiPlan[lotId][b.accountId] = null; state.aiInflight.delete(lotId + ':' + b.accountId); return; }
      const L = state.learn[b.accountId];
      const owned = goods.filter(g => g.owner_id === b.accountId).map(g => g.name);
      const waryEntry = Object.entries(L.waryOf || {}).sort((a, c) => c[1] - a[1])[0];
      const waryName = waryEntry && waryEntry[1] >= 1 ? (BIDDERS.find(x => x.accountId === waryEntry[0]) || {}).name : null;
      const ctx = {
        balance: bal,
        owned,
        multiplier: L.multiplier.toFixed(2),
        streak: L.streak > 0 ? `lost the last ${L.streak}` : 'no recent losses',
        wary: waryName,
      };
      const lot = { goodId: good.good_id, goodName: good.name, income, currentBid: Number(auction.current_bid), secsLeft, leader: auction.current_bidder ? (BIDDERS.find(x => x.accountId === auction.current_bidder) || {}).name || auction.current_bidder : null };
      return askAI(b, lot, ctx).then((plan) => {
        state.aiInflight.delete(lotId + ':' + b.accountId);
        state.aiPlan[lotId][b.accountId] = plan; // null means "AI failed, use rules"
        if (plan) {
          state.aiCalls += 1; state.aiOk += 1;
          log(`AI ${b.name} lot=${lotId} good=${good.good_id} maxPrice=${plan.maxPrice} aggression=${plan.aggression} line="${plan.line}"`);
        } else {
          state.aiCalls += 1; state.aiFail += 1;
          log(`AI FALLBACK ${b.name} lot=${lotId} good=${good.good_id} (no AI plan, using rules)`);
        }
      });
    }).catch(() => {
      state.aiInflight.delete(lotId + ':' + b.accountId);
      state.aiPlan[lotId][b.accountId] = null;
    });
  }
}

const _learned = loadLearnState();
const state = {
  rotateIdx: 0,
  lastPrice: {},      // good_id -> last settled winning bid
  heldSince: {},      // good_id -> { owner, sinceMs }
  lastFaucetCheck: 0,
  lastIncomeCheck: 0,
  lastPayoutCheck: 0,
  accounts: {},       // accountId -> near Account
  viewAccount: null,
  learn: _learned.bidders, // per-bidder learning state (persisted)
  drops: _learned.drops,   // per-good discounted starting bid after an unsold lot (persisted)
  bidsOn: {},         // auction_id -> Set of accountIds who bid (for learning at settle)
  aiPlan: {},         // auction_id -> { accountId -> {maxPrice, aggression, line} | null } (per-lot AI brain; null = AI failed, use rules)
  aiInflight: new Set(), // "auctionId:accountId" with an AI call running
  aiCalls: 0, aiOk: 0, aiFail: 0, // counters for the run (reported in the log)
};

async function view(method, args) {
  return state.viewAccount.viewFunction({ contractId: CONTRACT_ID, methodName: method, args });
}

async function callAs(accountId, method, args) {
  const acc = state.accounts[accountId];
  const tx = await acc.functionCall({ contractId: CONTRACT_ID, methodName: method, args, gas: GAS });
  return tx.transaction.hash;
}

async function balanceOf(accountId) {
  const b = await view('mt_balance_of', { account_id: accountId, token_id: 'gavel' });
  return Number(b);
}

async function maybePayoutPrize() {
  // Check at most every 5 minutes; the season lasts a day, so this is
  // plenty. When a season ends, pay the pool out to the top 3 owners
  // (anyone may call it — the house does it so the room pays out
  // without a dev). Logs the winners so the payout is on the record.
  const now = Date.now();
  if (now - state.lastPayoutCheck < 5 * 60 * 1000 && state.lastPayoutCheck !== 0) return;
  state.lastPayoutCheck = now;
  try {
    const season = await view('get_season_info', {});
    if (!season || !season.can_payout) return;
    const tx = await callAs(HOUSE_ID, 'payout_prize_pool', {});
    const last = await view('get_last_payout', {});
    const winners = (last && last.winners ? last.winners : []).map(w => `${w.account}=${w.amount}`).join(', ');
    log(`PRIZE season=${last ? last.season_number : '?'} paid total=${last ? last.total_paid : '?'} winners=[${winners}] tx=${tx}`);
  } catch (e) { log(`PRIZE ERROR: ${e.message.slice(0, 300)}`); }
}

async function maybeClaimFaucets() {
  // Check at most every 30 min (plus at startup); claim only if can_claim_faucet.
  const now = Date.now();
  if (now - state.lastFaucetCheck < 30 * 60 * 1000 && state.lastFaucetCheck !== 0) return;
  state.lastFaucetCheck = now;
  for (const b of BIDDERS) {
    try {
      const can = await view('can_claim_faucet', { account_id: b.accountId });
      if (can) {
        const tx = await callAs(b.accountId, 'claim_faucet', {});
        log(`FAUCET ${b.name} claimed +500 coins tx=${tx}`);
      }
    } catch (e) { log(`FAUCET ERROR ${b.name}: ${e.message.slice(0, 200)}`); }
  }
}

async function maybeClaimIncome(goods) {
  const now = Date.now();
  const dueHourly = now - state.lastIncomeCheck >= 60 * 60 * 1000;
  if (!dueHourly) {
    // Still check the >20 accrued trigger cheaply from the goods view we already have.
    const rich = goods.filter(g => Number(g.income_accrued) > 20);
    if (!rich.length) return;
    for (const g of rich) {
      try {
        const tx = await callAs(g.owner_id, 'claim_income', { good_id: g.good_id });
        log(`INCOME ${g.good_id} owner=${g.owner_id} accrued=${g.income_accrued} tx=${tx}`);
      } catch (e) { log(`INCOME ERROR ${g.good_id} (${g.owner_id}): ${e.message.slice(0, 200)}`); }
    }
    return;
  }
  state.lastIncomeCheck = now;
  for (const g of goods) {
    if (Number(g.income_accrued) <= 0) continue;
    // Only claim for goods owned by house or one of our bidders.
    if (g.owner_id !== HOUSE_ID && !BIDDERS.some(b => b.accountId === g.owner_id)) continue;
    try {
      const tx = await callAs(g.owner_id, 'claim_income', { good_id: g.good_id });
      log(`INCOME (hourly) ${g.good_id} owner=${g.owner_id} accrued=${g.income_accrued} tx=${tx}`);
    } catch (e) { log(`INCOME ERROR ${g.good_id} (${g.owner_id}): ${e.message.slice(0, 200)}`); }
  }
}

function trackOwnership(goods) {
  const now = Date.now();
  for (const g of goods) {
    const prev = state.heldSince[g.good_id];
    if (!prev || prev.owner !== g.owner_id) state.heldSince[g.good_id] = { owner: g.owner_id, since: now };
  }
}

async function openNextLot(goods, auctions) {
  // Prefer a house-owned good, rotating through the 8.
  const houseGoods = goods.filter(g => g.owner_id === HOUSE_ID);
  const inAuction = new Set(auctions.filter(a => !a.settled).map(a => a.good_id));
  const candidates = houseGoods.filter(g => !inAuction.has(g.good_id));
  let good, seller, startingBid;
  if (candidates.length) {
    good = candidates[state.rotateIdx % candidates.length];
    state.rotateIdx += 1;
    seller = HOUSE_ID;
    startingBid = Number(good.income_per_day) * 5;
  } else {
    // House owns nothing auctionable: re-auction a bidder-owned good held longest.
    const bidderGoods = goods
      .filter(g => BIDDERS.some(b => b.accountId === g.owner_id) && !inAuction.has(g.good_id))
      .sort((a, b) => (state.heldSince[a.good_id]?.since || 0) - (state.heldSince[b.good_id]?.since || 0));
    if (!bidderGoods.length) { log('OPEN: no good available to auction (all owned goods already in lots)'); return; }
    good = bidderGoods[0];
    seller = good.owner_id;
    const last = state.lastPrice[good.good_id];
    // A good that went unsold re-opens at its discounted price, not at
    // lastPrice x 1.05 — otherwise it would stay stuck above what
    // anyone will pay. The discount clears once the good sells.
    if (state.drops[good.good_id]) {
      startingBid = state.drops[good.good_id];
    } else {
      startingBid = last ? Math.ceil(last * 1.05) : Number(good.income_per_day) * 5;
    }
  }
  try {
    const tx = await callAs(seller, 'open_auction', { good_id: good.good_id, starting_bid: String(startingBid), duration_seconds: AUCTION_DURATION_S });
    log(`OPEN lot good=${good.good_id} (${good.name}, ${good.income_per_day}/day) seller=${seller} starting_bid=${startingBid} duration=${AUCTION_DURATION_S}s tx=${tx}`);
  } catch (e) { log(`OPEN ERROR ${good.good_id} seller=${seller}: ${e.message.slice(0, 300)}`); }
}

async function settleLot(auction) {
  try {
    const tx = await callAs(HOUSE_ID, 'settle_auction', { auction_id: auction.auction_id });
    log(`SETTLE auction=${auction.auction_id} good=${auction.good_id} winner=${auction.current_bidder || 'none'} final_bid=${auction.current_bid} bids=${auction.bids_count} tx=${tx}`);
    if (auction.current_bidder && Number(auction.current_bid) > 0) {
      state.lastPrice[auction.good_id] = Number(auction.current_bid);
    }
    /* ---- Learning: the bidders adjust from what just happened ---- */
    const biddersHere = state.bidsOn[auction.auction_id] || new Set();
    const winner = auction.current_bidder;
    const goodIncome = await view('get_goods', {}).then(gs => { const g = gs.find(x => x.good_id === auction.good_id); return g ? Number(g.income_per_day) : 0; }).catch(() => 0);
    /* ---- Price discovery: an unsold lot gets cheaper ----
       If nobody bid, the starting price was too high. Cut it 15%
       for the next opening (floor: 3 days of income, so a good never
       goes for less than it earns in three days). When the good
       finally sells, the drop clears and the last sale price sets
       the next starting bid again. This is how a stuck lot finds
       its level on its own — no dev has to reprice it. */
    if (!winner || Number(auction.bids_count) === 0) {
      const floor = Math.max(25, goodIncome * 3);
      const cut = Math.max(floor, Math.floor(Number(auction.starting_bid) * 0.85));
      state.drops[auction.good_id] = cut;
      log(`PRICE DROP ${auction.good_id} unsold at ${auction.starting_bid} — next starting bid ${cut} (floor ${floor})`);
    } else {
      delete state.drops[auction.good_id];
    }
    for (const b of BIDDERS) {
      if (!biddersHere.has(b.accountId)) continue;
      const L = state.learn[b.accountId];
      const old = L.multiplier;
      if (b.accountId === winner) {
        /* Won. Was it a good deal? */
        const payback = goodIncome > 0 ? Number(auction.current_bid) / goodIncome : 99;
        if (payback > 10) { L.multiplier = Math.max(3, L.multiplier * 0.92); L.streak = 0; }
        else if (payback < 6) { L.multiplier = Math.min(16, L.multiplier * 1.05); L.streak = 0; }
        else L.streak = 0;
        if (L.multiplier !== old) log(`LEARN ${b.name} won ${auction.good_id} payback=${payback.toFixed(1)}d multiplier ${old.toFixed(2)} -> ${L.multiplier.toFixed(2)}`);
      } else {
        /* Lost a lot they bid on. Bid harder next time, and get wary of the winner. */
        L.multiplier = Math.min(16, L.multiplier * 1.06);
        L.streak = (L.streak || 0) + 1;
        if (winner) L.waryOf[winner] = (L.waryOf[winner] || 0) + 1;
        log(`LEARN ${b.name} lost ${auction.good_id} to ${winner || 'nobody'} multiplier ${old.toFixed(2)} -> ${L.multiplier.toFixed(2)} (loss streak ${L.streak})`);
      }
    }
    delete state.bidsOn[auction.auction_id];
    delete state.aiPlan[auction.auction_id]; // the lot is over; its AI plans go with it
    saveLearnState();
  } catch (e) { log(`SETTLE ERROR auction=${auction.auction_id}: ${e.message.slice(0, 300)}`); }
}

async function maybeBid(auction, goods) {
  const good = goods.find(g => g.good_id === auction.good_id);
  if (!good) return;
  const income = Number(good.income_per_day);
  const nowMs = Date.now();
  const endsMs = Number(auction.ends_at) / 1e6;
  const secsLeft = Math.max(0, (endsMs - nowMs) / 1000);
  let urgency = 1;
  if (secsLeft < 30) urgency = 3; else if (secsLeft < 60) urgency = 2;
  const currentBid = Number(auction.current_bid);
  const bidsCount = auction.bids_count;

  for (const b of BIDDERS) {
    if (auction.current_bidder === b.accountId) continue; // already highest
    if (auction.seller_id === b.accountId) continue; // don't bid on own lot
    let bal;
    try { bal = await balanceOf(b.accountId); } catch (e) { log(`BALANCE ERROR ${b.name}: ${e.message.slice(0, 150)}`); continue; }
    /* ---- Self-recovery: a broke bidder sits out and rebuilds ----
       Below 300 coins they do not bid at all — they claim the faucet
       and the income from the goods they own until they are back
       above 500. This is what stops the economy needing a hand-out:
       a bidder who overspends recovers on their own instead of
       needing a manual top-up. */
    if (bal < 300) {
      log(`RECOVER ${b.name} balance=${bal} — sitting this lot out, rebuilding from faucet + income`);
      try {
        const can = await view('can_claim_faucet', { account_id: b.accountId });
        if (can) { const tx = await callAs(b.accountId, 'claim_faucet', {}); log(`RECOVER FAUCET ${b.name} +500 tx=${tx}`); }
      } catch (e) { /* faucet already claimed today; income will rebuild them */ }
      try {
        const goodsOwned = goods.filter(g => g.owner_id === b.accountId && Number(g.income_accrued) > 0);
        for (const g of goodsOwned) { const tx = await callAs(b.accountId, 'claim_income', { good_id: g.good_id }); log(`RECOVER INCOME ${b.name} ${g.good_id} accrued=${g.income_accrued} tx=${tx}`); }
      } catch (e) { log(`RECOVER INCOME ERROR ${b.name}: ${e.message.slice(0, 150)}`); }
      continue;
    }
    /* ---- Valuation: the AI brain first, the rules as fallback ----
       If the AI made a plan for this bidder on this lot, its maxPrice
       IS the valuation — it replaces income x learned multiplier x
       budget factor for this lot. The budget factor does not apply to
       the AI price (the AI already saw the balance); the balance still
       caps the actual bid below, and wariness still cuts the chance
       of bidding. If there is no AI plan, the rules valuation stands. */
    const L = state.learn[b.accountId];
    const plan = (state.aiPlan[auction.auction_id] || {})[b.accountId];
    let valuation;
    let source = 'rules';
    if (plan) {
      valuation = plan.maxPrice;
      source = 'ai';
    } else {
      let budgetFactor = 1;
      if (bal < 1000) budgetFactor = 0.8;
      else if (bal > 3000) budgetFactor = 1.15;
      valuation = income * L.multiplier * budgetFactor;
    }
    /* ---- Wariness: avoid a fight you keep losing ----
       If the current leader has outbid this bidder 3+ times, halve
       the chance of bidding and shave 10% off the valuation against
       them. They look for another lot instead of feeding the rival. */
    let p = Math.min(1, b.prob * urgency);
    if (plan) p = Math.min(1, p * (0.5 + 0.5 * plan.aggression)); // the AI's keenness scales how often they try
    const waryCount = (L.waryOf && auction.current_bidder) ? (L.waryOf[auction.current_bidder] || 0) : 0;
    if (waryCount >= 3) { p = p * 0.5; valuation = valuation * 0.9; }
    const minBid = bidsCount === 0 ? Number(auction.starting_bid) : currentBid + 25;
    if (minBid > valuation) continue; // starting bid already above what they'd pay
    if (Math.random() > p) continue;
    // Amount: jump over current (or starting bid if no bids yet).
    let amount;
    if (bidsCount === 0) {
      amount = Math.max(minBid, minBid + randInt(b.jumpMin, b.jumpMax) - 25);
      // First bid: just meet starting bid plus a small jump is fine; keep it simple.
      amount = minBid;
    } else {
      amount = currentBid + randInt(b.jumpMin, b.jumpMax);
    }
    if (amount < minBid) amount = minBid;
    if (amount > valuation) amount = valuation;
    if (amount < minBid) continue; // valuation below the minimum increment
    if (amount > bal) {
      // Bid what they can afford if it still meets the minimum.
      if (bal < minBid) { log(`SKIP ${b.name} auction=${auction.auction_id}: balance ${bal} < min bid ${minBid}`); continue; }
      amount = bal;
      if (amount > valuation) amount = valuation;
      if (amount < minBid) continue;
    }
    try {
      const tx = await callAs(b.accountId, 'place_bid', { auction_id: auction.auction_id, amount: String(amount) });
      log(`BID ${b.name} auction=${auction.auction_id} good=${auction.good_id} amount=${amount} (was ${currentBid}, valuation ${Math.round(valuation)} [${source}], mult ${state.learn[b.accountId].multiplier.toFixed(2)}, balance ${bal}, ${Math.round(secsLeft)}s left) tx=${tx}`);
      if (!state.bidsOn[auction.auction_id]) state.bidsOn[auction.auction_id] = new Set();
      state.bidsOn[auction.auction_id].add(b.accountId);
      // After a successful bid, re-read the auction state for the next bidder.
      const fresh = await view('get_auction', { auction_id: auction.auction_id });
      if (fresh) { auction.current_bid = fresh.current_bid; auction.current_bidder = fresh.current_bidder; auction.bids_count = fresh.bids_count; auction.ends_at = fresh.ends_at; }
    } catch (e) { log(`BID ERROR ${b.name} auction=${auction.auction_id} amount=${amount}: ${e.message.slice(0, 300)}`); }
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const [goods, auctions] = await Promise.all([
      view('get_goods', {}),
      view('get_auctions', {}),
    ]);
    trackOwnership(goods);
    const nowMs = Date.now();
    const open = auctions.filter(a => !a.settled && Number(a.ends_at) / 1e6 > nowMs);
    const ended = auctions.filter(a => !a.settled && Number(a.ends_at) / 1e6 <= nowMs);

    // Settle ended lots first.
    for (const a of ended) await settleLot(a);

    // Re-fetch open lots after settling (a settled lot frees its good).
    let live = open;
    if (ended.length) {
      const fresh = await view('get_auctions', {});
      live = fresh.filter(a => !a.settled && Number(a.ends_at) / 1e6 > Date.now());
    }

    if (!live.length) {
      await openNextLot(goods, auctions);
    } else {
      // Ask the AI brain for a plan on each live lot (fire-and-forget;
      // plans land a few seconds later and are used from the next tick).
      for (const a of live) ensureAIPlans(a, goods);
      for (const a of live) await maybeBid(a, goods);
    }

    await maybeClaimFaucets();
    await maybeClaimIncome(goods);
    await maybePayoutPrize();
  } catch (e) {
    log(`TICK ERROR: ${e.message.slice(0, 300)}`);
  } finally {
    ticking = false;
  }
}

(async () => {
  log('BOT STARTING contract=' + CONTRACT_ID);
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  const keyStore = new keyStores.InMemoryKeyStore();
  const accountIds = [HOUSE_ID, ...BIDDERS.map(b => b.accountId)];
  for (const id of accountIds) {
    const entry = raw[id];
    if (!entry || !entry.private_key) throw new Error('Missing key for ' + id);
    await keyStore.setKey('testnet', id, KeyPair.fromString(entry.private_key));
  }
  const near = await connect({
    networkId: 'testnet', keyStore,
    nodeUrl: RPC_URL,
    walletUrl: 'https://testnet.mynearwallet.com',
    helperUrl: 'https://helper.testnet.near.org',
    explorerUrl: 'https://testnet.nearblocks.io',
  });
  for (const id of accountIds) state.accounts[id] = await near.account(id);
  state.viewAccount = state.accounts[HOUSE_ID];

  // Startup state.
  try {
    const goods = await view('get_goods', {});
    const supply = await view('mt_total_supply', { token_id: 'gavel' });
    log(`STARTUP goods=${goods.length} total_supply=${supply} ai_model=${AI_MODEL}`);
    for (const b of BIDDERS) {
      const L = state.learn[b.accountId];
      log(`STARTUP ${b.name} ${b.accountId} balance=${await balanceOf(b.accountId)} multiplier=${L.multiplier.toFixed(2)} (base ${b.baseMultiplier}) waryOf=${JSON.stringify(L.waryOf)}`);
    }
    trackOwnership(goods);
  } catch (e) { log('STARTUP CHECK ERROR: ' + e.message.slice(0, 300)); }

  await tick();
  setInterval(tick, TICK_MS);
  log('BOT RUNNING tick=' + TICK_MS + 'ms');
})().catch((e) => {
  log('BOT FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
