// The Gavel — autonomous AI bidder bot (NEAR testnet).
// Polls every 4s: opens lots, bids as Mara/Bram/Pip, settles ended lots,
// claims faucet (daily) and income (hourly / when accrued > 20).
// Logs to ~/workspace/gavel/bot.log and stdout. Never crashes the loop.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';
const STATE_PATH = '/home/hatch/workspace/gavel/bot-state.json';
const LOG_PATH = '/home/hatch/workspace/gavel/bot.log';
const RPC_URL = 'https://rpc.testnet.fastnear.com';
const GAS = BigInt('30000000000000');
const TICK_MS = 4000;
const AUCTION_DURATION_S = 180;

// Bidders: name, base multiplier (valuation = income/day * mult), base prob/tick, jump.
// The multiplier is only the STARTING point — each bidder learns and their
// multiplier moves with results (see the learning state below). Nothing here
// is fixed for good.
const BIDDERS = [
  { name: 'Mara', accountId: 'gavel-mara-y08d0h.testnet', baseMultiplier: 12, prob: 0.35, jumpMin: 50, jumpMax: 100 },
  { name: 'Bram', accountId: 'gavel-bram-hag65w.testnet', baseMultiplier: 6, prob: 0.15, jumpMin: 25, jumpMax: 25 },
  { name: 'Pip', accountId: 'gavel-pip-76rddq.testnet', baseMultiplier: 8, prob: 0.08, jumpMin: 100, jumpMax: 100 },
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
    /* ---- Adaptive valuation: what they have learned, and what they hold ----
       valuation = income/day x learned multiplier x budget factor.
       Budget factor: poor (under 1000) -> 0.8x, comfortable -> 1x,
       rich (over 3000) -> 1.15x. A broke bidder bids low; a rich one
       bids freely. The multiplier itself moves with wins and losses
       (see settleLot), so the strategy evolves without a dev. */
    const L = state.learn[b.accountId];
    let budgetFactor = 1;
    if (bal < 1000) budgetFactor = 0.8;
    else if (bal > 3000) budgetFactor = 1.15;
    let valuation = income * L.multiplier * budgetFactor;
    /* ---- Wariness: avoid a fight you keep losing ----
       If the current leader has outbid this bidder 3+ times, halve
       the chance of bidding and shave 10% off the valuation against
       them. They look for another lot instead of feeding the rival. */
    let p = Math.min(1, b.prob * urgency);
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
      log(`BID ${b.name} auction=${auction.auction_id} good=${auction.good_id} amount=${amount} (was ${currentBid}, valuation ${Math.round(valuation)}, mult ${state.learn[b.accountId].multiplier.toFixed(2)}, balance ${bal}, ${Math.round(secsLeft)}s left) tx=${tx}`);
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
    log(`STARTUP goods=${goods.length} total_supply=${supply}`);
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
