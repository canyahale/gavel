/* Node verification for the Gavel speed optimization.
   Loads the real gavel-shared.js with browser globals shimmed.
   Proves:
   - seat creation works; access-key cache is warm after connectSeat
     (claim sign issues ZERO view_access_key queries)
   - timed claim + bid with sign/broadcast/receipt split, tx hashes,
     on-chain state verified after each move
   - sequential read fallback: dead fastnear falls through to next endpoint
   - error paths: stalled sign fails fast (10s timeout, all endpoints),
     unknown-hash receipt rejects at the 15s deadline (dropped tx = failure),
     queue not poisoned after failures (later claim rejects via receipt)
   Usage: node test/speed-test-node.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nearApi = require("near-api-js");

const store = new Map();
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }
};
global.window = { localStorage: localStorageShim, nearApi };
global.localStorage = localStorageShim;
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");

const sharedPath = path.join(__dirname, "..", "gavel-shared.js");
vm.runInThisContext(fs.readFileSync(sharedPath, "utf8"), { filename: "gavel-shared.js" });

const t0 = Date.now();
const log = (...a) => console.log("[" + ((Date.now() - t0) / 1000).toFixed(2) + "s]", ...a);
const name = "speedtest" + Math.floor(Math.random() * 900000 + 100000);

(async () => {
  global.player.name = name;

  // --- 1. Seat ---
  const seatStart = Date.now();
  const accountId = await global.ensureSeat();
  const seatMs = Date.now() - seatStart;
  log("SEAT ready:", accountId, seatMs + "ms");
  log("ACCESS-KEY CACHE immediately after seat:", JSON.stringify(Object.keys(global.seatAccount.accessKeyByPublicKeyCache || {})));
  // The warm is fire-and-forget: give its view_access_key round-trip a
  // moment to land, as in the real flow (seat is set up in the
  // background; the player taps Claim seconds later).
  await new Promise((r) => setTimeout(r, 2000));
  const cacheKeys = Object.keys(global.seatAccount.accessKeyByPublicKeyCache || {});
  log("ACCESS-KEY CACHE 2s after seat (warm check):", JSON.stringify(cacheKeys));

  // --- instrument sign/broadcast/receipt + count view_access_key queries ---
  const timings = { viewAccessKeyQueries: 0, signs: [], broadcasts: [], receipts: [] };
  const provider = global.seatAccount.connection.provider;
  const origQuery = provider.query.bind(provider);
  provider.query = function (args) {
    if (args && args.request_type === "view_access_key") timings.viewAccessKeyQueries++;
    return origQuery(args);
  };
  const origSign = global.seatAccount.signTransaction.bind(global.seatAccount);
  global.seatAccount.signTransaction = function (...a) {
    const s = Date.now();
    return origSign(...a).then((v) => { timings.signs.push(Date.now() - s); return v; },
      (e) => { timings.signs.push(Date.now() - s); throw e; });
  };
  const origSend = provider.sendTransactionAsync.bind(provider);
  provider.sendTransactionAsync = function (...a) {
    const s = Date.now();
    return origSend(...a).then((v) => { timings.broadcasts.push(Date.now() - s); return v; },
      (e) => { timings.broadcasts.push(Date.now() - s); throw e; });
  };
  const origTxStatus = provider.txStatus.bind(provider);
  provider.txStatus = function (...a) {
    const s = Date.now();
    return origTxStatus(...a).then((v) => { timings.receipts.push(Date.now() - s); return v; },
      (e) => { timings.receipts.push(Date.now() - s); throw e; });
  };

  // --- 2. Claim ---
  const claimStart = Date.now();
  const claimHash = await global.signedCall("claim_faucet", {});
  const claimMs = Date.now() - claimStart;
  log("CLAIM hash:", claimHash, "total", claimMs + "ms",
    "sign", JSON.stringify(timings.signs), "broadcast", JSON.stringify(timings.broadcasts),
    "receipt polls", timings.receipts.length + "x", JSON.stringify(timings.receipts),
    "view_access_key queries during claim:", timings.viewAccessKeyQueries);
  const balAfterClaim = await global.rpcCall("mt_balance_of", { account_id: accountId, token_id: "gavel" });
  const canClaim = await global.rpcCall("can_claim_faucet", { account_id: accountId });
  log("ON-CHAIN after claim: balance", balAfterClaim, "can_claim", canClaim);

  // --- 3. Bid on the current lot ---
  const open = await global.rpcCall("get_open_auctions", {});
  log("OPEN auctions:", (open || []).length);
  let bidHash = null, bidMs = null;
  if (open && open.length) {
    open.sort((a, b) => a.ends_at - b.ends_at);
    const lot = open[0];
    const amount = lot.bids_count === 0 ? Number(lot.starting_bid) : Number(lot.current_bid) + 25;
    const bidStart = Date.now();
    const s0 = timings.signs.length, b0 = timings.broadcasts.length, r0 = timings.receipts.length, q0 = timings.viewAccessKeyQueries;
    bidHash = await global.signedCall("place_bid", { auction_id: lot.auction_id, amount: String(amount) });
    bidMs = Date.now() - bidStart;
    log("BID hash:", bidHash, "auction", lot.auction_id, "amount", amount, "total", bidMs + "ms",
      "sign", JSON.stringify(timings.signs.slice(s0)), "broadcast", JSON.stringify(timings.broadcasts.slice(b0)),
      "receipt polls", timings.receipts.length - r0 + "x", JSON.stringify(timings.receipts.slice(r0)),
      "view_access_key queries during bid:", timings.viewAccessKeyQueries - q0);
    const openAfter = await global.rpcCall("get_open_auctions", {});
    const lotAfter = (openAfter || []).find((a) => a.auction_id === lot.auction_id);
    log("ON-CHAIN after bid: lot", lot.auction_id, "bidder", lotAfter && lotAfter.current_bidder,
      "bid", lotAfter && lotAfter.current_bid, "isMe", lotAfter && lotAfter.current_bidder === accountId);
    const balAfterBid = await global.rpcCall("mt_balance_of", { account_id: accountId, token_id: "gavel" });
    log("ON-CHAIN after bid: balance", balAfterBid);
  } else {
    log("BID SKIPPED: no open lot");
  }

  // --- 4. Sequential fallback: kill fastnear, reads must still work ---
  const savedUrls = global.RPC_URLS.slice();
  global.RPC_URLS[0] = "http://127.0.0.1:9/dead";
  const fbStart = Date.now();
  const goods = await global.rpcCall("get_goods", {});
  log("FALLBACK with fastnear dead: get_goods returned", Array.isArray(goods) ? goods.length + " goods" : goods, "in", (Date.now() - fbStart) + "ms");
  global.RPC_URLS[0] = savedUrls[0];

  // --- 5a. Stalled sign must fail fast (10s timeout per endpoint).
  // Stub BOTH the prototype (fallback reconnects build fresh Account
  // objects from it) and the current instance (an earlier timing
  // wrapper captured the original method). Expect ~30s: 10s x 3 endpoints.
  const stallStart = Date.now();
  const realProtoSign = nearApi.Account.prototype.signTransaction;
  const hang = function () { return new Promise(() => {}); };
  nearApi.Account.prototype.signTransaction = hang;
  global.seatAccount.signTransaction = hang;
  try {
    await global.signedCall("claim_faucet", {});
    log("STALL-SIGN: UNEXPECTED SUCCESS");
  } catch (e) {
    log("STALL-SIGN rejected in", (Date.now() - stallStart) + "ms:", String((e && e.message) || e).slice(0, 120));
  }
  nearApi.Account.prototype.signTransaction = realProtoSign;

  // --- 5b. Dropped tx: unknown hash never lands -> receipt rejects at deadline ---
  const dropStart = Date.now();
  try {
    await global.waitForReceipt(new Uint8Array(32).fill(7));
    log("DROPPED-TX: UNEXPECTED SUCCESS");
  } catch (e) {
    log("DROPPED-TX rejected in", (Date.now() - dropStart) + "ms:", String((e && e.message) || e).slice(0, 120));
  }

  // --- 5c. Queue not poisoned: a further claim must reject via receipt (already claimed) ---
  const qStart = Date.now();
  try {
    await global.signedCall("claim_faucet", {});
    log("QUEUE-AFTER-FAILURE: UNEXPECTED SUCCESS");
  } catch (e) {
    log("QUEUE-AFTER-FAILURE rejected in", (Date.now() - qStart) + "ms:", String((e && e.message) || e).slice(0, 160));
  }
  // And one more move after that rejection, to prove the queue still runs.
  const q2Start = Date.now();
  try {
    await global.signedCall("claim_faucet", {});
    log("QUEUE-2ND: UNEXPECTED SUCCESS");
  } catch (e) {
    log("QUEUE-2ND rejected in", (Date.now() - q2Start) + "ms:", String((e && e.message) || e).slice(0, 120));
  }

  log("NODE TEST DONE. seatMs", seatMs, "claimMs", claimMs, "bidMs", bidMs,
    "claimHash", claimHash, "bidHash", bidHash,
    "viewAccessKeyQueriesDuringClaim", timings.viewAccessKeyQueries,
    "cacheWarm", cacheKeys.length > 0);
})().catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
