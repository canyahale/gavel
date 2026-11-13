// The Gavel — autonomous AI bidder bot (NEAR testnet).
// Polls every 4s: opens lots, bids as Mara/Bram/Pip, settles ended lots,
// claims faucet (daily) and income (hourly / when accrued > 20).
// Logs to ~/workspace/gavel/bot.log and stdout. Never crashes the loop.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';
const LOG_PATH = '/home/hatch/workspace/gavel/bot.log';
const RPC_URL = 'https://rpc.testnet.fastnear.com';
const GAS = BigInt('30000000000000');
const TICK_MS = 4000;
const AUCTION_DURATION_S = 180;

// Bidders: name, multiplier (valuation = income/day * mult), base prob/tick, jump.
const BIDDERS = [
  { name: 'Mara', accountId: 'gavel-mara-y08d0h.testnet', multiplier: 12, prob: 0.35, jumpMin: 50, jumpMax: 100 },
  { name: 'Bram', accountId: 'gavel-bram-hag65w.testnet', multiplier: 6, prob: 0.15, jumpMin: 25, jumpMax: 25 },
  { name: 'Pip', accountId: 'gavel-pip-76rddq.testnet', multiplier: 8, prob: 0.08, jumpMin: 100, jumpMax: 100 },
];
const HOUSE_ID = CONTRACT_ID;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) { console.error('log write failed', e.message); }
}

function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

const state = {
  rotateIdx: 0,
  lastPrice: {},      // good_id -> last settled winning bid
  heldSince: {},      // good_id -> { owner, sinceMs }
  lastFaucetCheck: 0,
  lastIncomeCheck: 0,
  lastPayoutCheck: 0,
  accounts: {},       // accountId -> near Account
  viewAccount: null,
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
    startingBid = last ? Math.ceil(last * 1.05) : Number(good.income_per_day) * 5;
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
    const valuation = income * b.multiplier;
    const minBid = bidsCount === 0 ? Number(auction.starting_bid) : currentBid + 25;
    if (minBid > valuation) continue; // starting bid already above what they'd pay
    const p = Math.min(1, b.prob * urgency);
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
    let bal;
    try { bal = await balanceOf(b.accountId); } catch (e) { log(`BALANCE ERROR ${b.name}: ${e.message.slice(0, 150)}`); continue; }
    if (amount > bal) {
      // Bid what they can afford if it still meets the minimum.
      if (bal < minBid) { log(`SKIP ${b.name} auction=${auction.auction_id}: balance ${bal} < min bid ${minBid}`); continue; }
      amount = bal;
      if (amount > valuation) amount = valuation;
      if (amount < minBid) continue;
    }
    try {
      const tx = await callAs(b.accountId, 'place_bid', { auction_id: auction.auction_id, amount: String(amount) });
      log(`BID ${b.name} auction=${auction.auction_id} good=${auction.good_id} amount=${amount} (was ${currentBid}, valuation ${valuation}, balance ${bal}, ${Math.round(secsLeft)}s left) tx=${tx}`);
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
    for (const b of BIDDERS) log(`STARTUP ${b.name} ${b.accountId} balance=${await balanceOf(b.accountId)}`);
    trackOwnership(goods);
  } catch (e) { log('STARTUP CHECK ERROR: ' + e.message.slice(0, 300)); }

  await tick();
  setInterval(tick, TICK_MS);
  log('BOT RUNNING tick=' + TICK_MS + 'ms');
})().catch((e) => {
  log('BOT FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
