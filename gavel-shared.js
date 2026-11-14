"use strict";

/* ================= The Gavel — shared helpers ================= */
/* Plain JS, plus near-api-js for signing (each page loads
   near-api-js.min.js before this file). Loaded by leaderboard.html,
   goods.html and market.html. The Room page (index.html) keeps its own
   copy of the same logic; this file is the shared version for the new pages.
   Player-facing words only: coins, chips, goods, the room. */

var CONTRACT_ID = "gavel-0lycf4.testnet";
var RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
var TOKEN_ID = "gavel";
var SHARE_PRICE = 100;

var AGENTS = [
  { name: "Mara", account: "gavel-mara-y08d0h.testnet", style: "Aggressive — bids early and big", color: "#e0533d", colorHex: 0xe0533d },
  { name: "Bram", account: "gavel-bram-hag65w.testnet", style: "Cautious — waits, then pounces", color: "#4a7fd4", colorHex: 0x4a7fd4 },
  { name: "Pip",  account: "gavel-pip-76rddq.testnet",  style: "Nearly broke — every bid counts", color: "#d9a62e", colorHex: 0xd9a62e }
];
var HOUSE_ACCOUNT = CONTRACT_ID;

function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
function fmt(n) { n = Math.round(Number(n) || 0); return n.toLocaleString("en-GB"); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function kindLabel(k) { return { stall: "Stall", route: "Route", recipe: "Recipe", relic: "Relic" }[k] || k; }

function displayName(account) {
  if (!account) return "—";
  if (account === player.accountId) return player.name || "You";
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].account === account) return AGENTS[i].name;
  if (account === HOUSE_ACCOUNT) return "The House";
  return "A bidder";
}
function agentByAccount(account) {
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].account === account) return AGENTS[i];
  return null;
}

/* ================= Network reads (direct, raced across endpoints) ================= */
function fetchWithTimeout(url, options, timeoutMs) {
  var ms = timeoutMs || 8000;
  if (typeof AbortController === "undefined") return fetch(url, options);
  var ctrl = new AbortController();
  var opts = {}; for (var k in options) opts[k] = options[k];
  opts.signal = ctrl.signal;
  var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
  return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (err) { clearTimeout(timer); throw err; });
}
function rpcCallVia(rpcUrl, methodName, argsObj) {
  var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(argsObj))));
  return fetchWithTimeout(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gavel-read", method: "query", params: { request_type: "call_function", account_id: CONTRACT_ID, method_name: methodName, args_base64: b64, finality: "optimistic" } })
  }, 30000).then(function (resp) { return resp.json(); }).then(function (json) {
    if (json && json.result && json.result.result) {
      var bytes = json.result.result, text = "";
      for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      return JSON.parse(decodeURIComponent(escape(text)));
    }
    throw new Error("read failed");
  });
}
function rpcCall(methodName, argsObj, attempt) {
  attempt = attempt || 0;
  return new Promise(function (resolve, reject) {
    var settled = false, failed = 0, lastErr = null;
    RPC_URLS.forEach(function (url) {
      rpcCallVia(url, methodName, argsObj).then(function (v) { if (!settled) { settled = true; resolve(v); } },
        function (err) {
          lastErr = err; failed += 1;
          if (failed >= RPC_URLS.length && !settled) {
            /* One retry after a short pause: the live browser's
               network path to the RPC endpoints can drop a whole
               round of reads, and a single retry recovers it. */
            if (attempt < 1) {
              setTimeout(function () { rpcCall(methodName, argsObj, attempt + 1).then(resolve, reject); }, 2000);
            } else {
              settled = true; reject(lastErr || new Error("read failed"));
            }
          }
        });
    });
  });
}
function viewAccountVia(rpcUrl, accountId) {
  return fetchWithTimeout(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gavel-view", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } })
  }, 30000).then(function (resp) { return resp.json(); }).then(function (json) {
    if (json && json.result) return json.result;
    var msg = json && json.error ? String(json.error.name || "") + " " + String(json.error.message || "") : "";
    if (/not exist|UNKNOWN_ACCOUNT|unknown account/i.test(msg)) return null;
    throw new Error("account check failed");
  });
}
function viewAccount(accountId) {
  return new Promise(function (resolve, reject) {
    var settled = false, failed = 0, sawMissing = false;
    RPC_URLS.forEach(function (url) {
      viewAccountVia(url, accountId).then(function (info) {
        if (settled) return;
        if (info) { settled = true; resolve(info); return; }
        sawMissing = true; failed += 1;
        if (failed >= RPC_URLS.length) { settled = true; resolve(null); }
      }, function () {
        if (settled) return; failed += 1;
        if (failed >= RPC_URLS.length) { settled = true; if (sawMissing) resolve(null); else reject(new Error("account check failed")); }
      });
    });
  });
}

/* ================= Player seat (the player's own account) =================
   Each player gets their own account, made for a key generated right
   here in this browser. The display name is only a label — it never
   decides the account and never authorises a move. The key is stored
   on this device only, under gavelKey:<name>, next to the account id
   under gavelSeat:<name>. Coming back with the same name restores the
   same seat and its chips. No shared accounts: this page
   signs each move itself with the player's own key, through
   near-api-js (window.nearApi, loaded by each page before this file).
   A new account is created through the testnet helper, which funds it
   with a little for signing; the name is taken if the helper says so,
   and a fresh random suffix is tried instead. */
var HELPER_URL = "https://helper.testnet.near.org/account";
var SEAT_GAS = BigInt(30000000000000);
var _savedName = storeGet("gavelName") || "";
var _savedSeat = _savedName ? storeGet("gavelSeat:" + _savedName) : null;
var _savedKey = _savedName ? storeGet("gavelKey:" + _savedName) : null;
var player = { name: _savedName, accountId: (_savedSeat && _savedKey) ? _savedSeat : null, balance: null, canClaim: null, ready: false, ensuring: null };
var seatAccount = null; /* near-api-js Account for the player's own seat, rebuilt by ensureSeat */
var seatKeyPair = null; /* the player's own keypair, rebuilt from storage or generated fresh */
var seatRpcUrl = null; /* nodeUrl the seat is currently connected to — fastnear unless a bid fell back */

function getNearApi() {
  return (typeof window !== "undefined" && window.nearApi) ? window.nearApi : null;
}
function randomSuffix() {
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
  for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function seatAccountIdFor(name) {
  var base = String(name || "player").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-") || "player";
  base = base.slice(0, 43);
  /* "gavel-" (6) + base (<=43) + "-" (1) + suffix (6) + ".testnet" (8) = at most 64 chars. */
  return "gavel-" + base + "-" + randomSuffix() + ".testnet";
}
function connectSeat(keyPair, accountId, nodeUrl) {
  var api = getNearApi();
  var url = nodeUrl || RPC_URLS[0];
  var keyStore = new api.keyStores.InMemoryKeyStore();
  return keyStore.setKey("testnet", accountId, keyPair).then(function () {
    return api.connect({
      networkId: "testnet", keyStore: keyStore,
      nodeUrl: url,
      walletUrl: "https://testnet.mynearwallet.com",
      helperUrl: "https://helper.testnet.near.org",
      explorerUrl: "https://testnet.nearblocks.io"
    });
  }).then(function (near) {
    return near.account(accountId);
  }).then(function (account) {
    seatAccount = account;
    seatKeyPair = keyPair;
    seatRpcUrl = url;
    player.accountId = accountId;
    player.ready = true;
    return accountId;
  });
}
function createSeat(name, triesLeft) {
  var api = getNearApi();
  if (!api) return Promise.reject(new Error("The seat could not be made — the signing code did not load. Check your connection and tap again."));
  var keyPair = api.KeyPair.fromRandom("ed25519");
  var accountId = seatAccountIdFor(name);
  return fetch(HELPER_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() })
  }).then(function (resp) {
    if (resp.ok) return null;
    return resp.text().then(function (text) {
      if (triesLeft > 0 && /taken|already exists/i.test(String(text || ""))) return "retry";
      throw new Error("The room could not make your seat (helper " + resp.status + "). Check your connection and tap again.");
    });
  }).then(function (retry) {
    if (retry === "retry") return createSeat(name, triesLeft - 1);
    /* Store the key and the account only once the helper has made the
       account, so a stored seat is always a real one. */
    storeSet("gavelKey:" + name, keyPair.toString());
    storeSet("gavelSeat:" + name, accountId);
    return connectSeat(keyPair, accountId);
  });
}

function ensureSeat() {
  if (player.ready && player.accountId && seatAccount) return Promise.resolve(player.accountId);
  if (player.ensuring) return player.ensuring;
  if (!player.name) return Promise.reject(new Error("Take a seat first — pick a name on the Room page."));
  var name = player.name;
  var savedSeat = storeGet("gavelSeat:" + name);
  var savedKey = storeGet("gavelKey:" + name);
  if (savedSeat && savedKey) {
    var api = getNearApi();
    if (!api) return Promise.reject(new Error("The seat could not be set up — the signing code did not load. Check your connection and tap again."));
    var keyPair = null;
    try { keyPair = api.KeyPair.fromString(savedKey); } catch (e) { keyPair = null; }
    if (keyPair) {
      player.ensuring = viewAccount(savedSeat).then(function (info) {
        if (!info) {
          /* The stored seat never made it onto the chain, so drop it
             and make a fresh one instead of retrying a broken seat. */
          try { localStorage.removeItem("gavelSeat:" + name); localStorage.removeItem("gavelKey:" + name); } catch (e) {}
          return createSeat(name, 4);
        }
        return connectSeat(keyPair, savedSeat);
      }, function () {
        /* The account check itself failed (network) — still try the
           stored seat rather than stranding the player. */
        return connectSeat(keyPair, savedSeat);
      });
      player.ensuring.then(function () {}, function () { player.ensuring = null; });
      return player.ensuring;
    }
    /* Stored key is unreadable — drop the broken seat and start fresh. */
    try { localStorage.removeItem("gavelSeat:" + name); localStorage.removeItem("gavelKey:" + name); } catch (e) {}
  }
  player.ensuring = createSeat(name, 4);
  player.ensuring.then(function () {}, function () { player.ensuring = null; });
  return player.ensuring;
}

/* Submit by broadcast, then verify the receipt. The old path used
   account.functionCall, which waits for EXECUTED_OPTIMISTIC (~4s,
   and up to ~15s on a slow endpoint) before resolving. The room's
   fast poll picks a bid up once it lands on-chain, so the submit
   only needs the network to accept the transaction: sign it with
   the player's own key and broadcast with
   provider.sendTransactionAsync, which returns as soon as the
   network accepts it (wait_until NONE). The receipt is then checked
   directly: poll txStatus with wait_until NONE every ~500ms (up to
   ~15s) and resolve with the transaction hash (hex) only once the
   receipt shows success. A broadcast that never lands — a dropped
   transaction — now rejects instead of reporting success. Every
   provider call inside the submit is raced against a short timeout
   (10s to sign, 10s to broadcast, 5s per receipt poll), so a stalled
   endpoint can never leave a move pending forever.
   One transaction at a time per seat: every submit is chained onto
   a single promise queue, so two moves fired at once (a claim and
   a settle, a bid and a settle) can never sign against the same
   access-key nonce. The queue tail always settles, success or
   failure, so a failed move never blocks the next one.
   near-api-js caches the access key (and its nonce) on the seat's
   Account object and never refreshes it after signing, so the queue
   alone is not enough: once a receipt confirms success the cached
   nonce is bumped to the nonce just used, and after any failure the
   cached key is dropped so the next sign re-reads it from the chain. */
/* Race a promise against a clock. near-api-js 5.1.1 exposes no timeout
   on its provider calls, and its own fetch has none either: a stalled
   endpoint (or the bundle's ~113s internal retry loop on a failing
   fetch) can leave a call pending forever, which used to leave the
   claim button on "Claiming…" forever. The timeout only rejects the
   raced promise — the underlying call, if it ever settles, is ignored.
   These timeouts are deliberately far shorter than that ~113s stall. */
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error(label + " timed out after " + ms + "ms"));
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true; clearTimeout(timer); resolve(v);
    }, function (err) {
      if (done) return;
      done = true; clearTimeout(timer); reject(err);
    });
  });
}
var signQueue = Promise.resolve();
function signedCall(method, args) {
  var run = function () {
    return ensureSeat().then(function () {
      /* Prefer the fastest RPC for every submit: if an earlier bid fell
         back to a slower endpoint, come back to fastnear first. This
         reconnect is local only — no network round-trip. */
      if (seatRpcUrl && seatRpcUrl !== RPC_URLS[0]) {
        return connectSeat(seatKeyPair, player.accountId, RPC_URLS[0]);
      }
    }).then(function () {
      return submitSignedCall(method, args || {}, 0);
    });
  };
  /* Chain onto the queue whether the previous move succeeded or
     failed, so the queue never deadlocks on a rejection. */
  var result = signQueue.then(run, run);
  signQueue = result.then(function () {}, function () {});
  return result;
}
function txHashHex(hash) {
  var hex = "";
  for (var i = 0; i < hash.length; i++) hex += ("0" + hash[i].toString(16)).slice(-2);
  return hex;
}
function submitSignedCall(method, args, rpcIndex) {
  var api = getNearApi();
  /* Sign, raced against a 10s timeout: a stalled provider fetch inside
     signTransaction never settles on its own, and the bundle retries a
     failing fetch for ~113s before rejecting. A timeout here means
     nothing was broadcast yet, so the rejection falls through to the
     RPC fallback on the next endpoint below — exactly like any other
     sign failure. */
  return withTimeout(seatAccount.signTransaction(CONTRACT_ID, [
    api.transactions.functionCall(method, args, SEAT_GAS, BigInt(0))
  ]), 10000, "Signing").then(function (signed) {
    var signedTx = signed[1];
    var hashBytes = signed[0];
    /* Broadcast only — returns as soon as the network accepts the
       transaction. No wait for execution, no status probe before
       submitting. Raced against a 10s timeout: a timeout here is
       ambiguous (the transaction may already have been accepted), so
       it is NOT retried with a fresh transaction — instead the receipt
       poll below decides whether this hash landed. Any other broadcast
       rejection is thrown, and a fresh transaction is never signed. */
    return withTimeout(seatAccount.connection.provider.sendTransactionAsync(signedTx), 10000, "Broadcast").then(function () {
      return waitForReceipt(hashBytes);
    }, function (broadcastErr) {
      if (broadcastErr && /timed out/.test(String(broadcastErr.message || ""))) return waitForReceipt(hashBytes);
      throw broadcastErr;
    }).then(function () {
      /* The receipt confirms the transaction executed: the nonce it
         used is now spent on-chain, so move the cached access key
         forward to it. Without this the next sign would reuse the
         same nonce — near-api-js never refreshes the cached key
         after signing. */
      bumpCachedNonce(signedTx);
      return txHashHex(hashBytes);
    }, function (err) {
      /* The transaction did not land (or its receipt failed): drop
         the cached access key so the next sign re-reads the nonce
         from the chain instead of trusting a stale one. */
      dropCachedAccessKey(signedTx);
      throw err;
    });
  }, function (err) {
    if (rpcIndex + 1 < RPC_URLS.length) {
      /* The sign step failed before anything was broadcast — the sign
         reads the block hash, so a dead endpoint fails fast here, with
         no separate status probe. Safe to retry on the next RPC. A
         failure after broadcast is never retried: the transaction may
         already be accepted, and a retry could bid twice. */
      return connectSeat(seatKeyPair, player.accountId, RPC_URLS[rpcIndex + 1]).then(function () {
        return submitSignedCall(method, args, rpcIndex + 1);
      });
    }
    throw err;
  });
}
function cachedAccessKeyFor(signedTx) {
  try {
    var cache = seatAccount && seatAccount.accessKeyByPublicKeyCache;
    if (!cache) return null;
    var key = signedTx.transaction.publicKey.toString();
    return { cache: cache, key: key };
  } catch (e) { return null; }
}
function bumpCachedNonce(signedTx) {
  var entry = cachedAccessKeyFor(signedTx);
  if (!entry || !entry.cache[entry.key]) return;
  entry.cache[entry.key] = Object.assign({}, entry.cache[entry.key], { nonce: signedTx.transaction.nonce });
}
function dropCachedAccessKey(signedTx) {
  var entry = cachedAccessKeyFor(signedTx);
  if (!entry) return;
  try { delete entry.cache[entry.key]; } catch (e) {}
}
/* Poll the transaction receipt until it executes or the timeout
   expires. Each check is one quick txStatus query with wait_until
   NONE — it never waits itself — raced against a 5s timeout, so a
   stalled poll is treated like "not found yet" and polling simply
   continues. A standalone timer rejects at the 15s deadline even if
   a poll is still in flight, so the wait can never hang past the
   deadline; resolve/reject happen at most once. A transaction the
   network dropped never shows up, so the poll ends in a rejection
   instead of a false success. Resolves once the receipt shows
   success; rejects with the contract's failure reason when the
   receipt shows failure, or when 15s pass without the transaction
   landing. */
function waitForReceipt(hashBytes) {
  var provider = seatAccount.connection.provider;
  var accountId = player.accountId;
  var deadlineMs = 15000;
  var deadline = Date.now() + deadlineMs;
  return new Promise(function (resolve, reject) {
    var settled = false;
    var deadlineTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("The move was sent but did not land in time — try again."));
    }, deadlineMs);
    function done(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      fn(arg);
    }
    (function check() {
      if (settled) return;
      withTimeout(provider.txStatus(hashBytes, accountId, "NONE"), 5000, "Receipt check").then(function (outcome) {
        if (settled) return;
        var status = outcome && outcome.status;
        if (status && status.SuccessValue !== undefined) { done(resolve); return; }
        if (status && status.Failure) { done(reject, new Error("That move did not go through: " + receiptFailureText(status.Failure))); return; }
        /* No receipt yet — keep waiting until the timeout. */
        if (Date.now() >= deadline) { done(reject, new Error("The move was sent but did not land in time — try again.")); return; }
        setTimeout(check, 500);
      }, function () {
        /* Not found yet, a wobbly endpoint, or a timed-out poll —
           keep polling until the timeout; a dropped transaction
           simply never appears. */
        if (settled) return;
        if (Date.now() >= deadline) { done(reject, new Error("The move was sent but did not land in time — try again.")); return; }
        setTimeout(check, 500);
      });
    })();
  });
}
function receiptFailureText(failure) {
  try {
    var kind = failure && failure.ActionError && failure.ActionError.kind;
    if (kind) {
      if (typeof kind === "string") return kind;
      if (kind.FunctionCallError) {
        var fce = kind.FunctionCallError;
        if (typeof fce === "string") return fce;
        if (fce.ExecutionError) return String(fce.ExecutionError);
        return JSON.stringify(fce);
      }
      return JSON.stringify(kind);
    }
    return JSON.stringify(failure);
  } catch (e) {
    return "unknown error";
  }
}

/* ================= Goods helpers ================= */
function saleHistory(goodId, auctions) {
  var done = (auctions || []).filter(function (a) { return a.good_id === goodId && a.settled && a.winner; });
  done.sort(function (a, b) { return b.auction_id - a.auction_id; });
  return done;
}
function paybackDays(price, incomePerDay) {
  var inc = Number(incomePerDay) || 0;
  if (!inc || !price) return null;
  return Math.max(1, Math.ceil(Number(price) / inc));
}
function isRare(good) {
  return Number(good.income_per_day) >= 300;
}
function goodValue(good, auctions, openAuctions) {
  var hist = saleHistory(good.good_id, auctions);
  if (hist.length) return Number(hist[0].current_bid) || 0;
  if (good.listed_price != null) return Number(good.listed_price) || 0;
  var open = openAuctions || [];
  for (var i = 0; i < open.length; i++) {
    if (open[i].good_id === good.good_id) return Number(open[i].starting_bid) || 0;
  }
  return (Number(good.income_per_day) || 0) * 30;
}

/* ================= One fetch for the whole game state =================
   Each read tolerates failure (null), like the Room page's poll. */
function loadGameData() {
  var calls = [
    rpcCall("get_goods", {}).catch(function () { return null; }),
    rpcCall("get_open_auctions", {}).catch(function () { return null; }),
    rpcCall("get_auctions", {}).catch(function () { return null; }),
    rpcCall("get_all_shares", {}).catch(function () { return null; }),
    rpcCall("get_prize_pool", {}).catch(function () { return null; }),
    rpcCall("get_season_info", {}).catch(function () { return null; }),
    rpcCall("get_leaderboard", {}).catch(function () { return null; }),
    rpcCall("get_last_payout", {}).catch(function () { return null; })
  ];
  return Promise.all(calls).then(function (r) {
    return {
      goods: r[0],
      openAuctions: r[1],
      auctions: r[2],
      shares: r[3],
      prize: r[4],
      season: r[5],
      board: r[6],
      lastPayout: r[7]
    };
  });
}
