"use strict";

/* ================= The Gavel — shared helpers ================= */
/* Plain JS, no libraries. Loaded by leaderboard.html, goods.html and
   market.html. The Room page (index.html) keeps its own copy of the
   same logic; this file is the shared version for the new pages.
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
  }, 20000).then(function (resp) { return resp.json(); }).then(function (json) {
    if (json && json.result && json.result.result) {
      var bytes = json.result.result, text = "";
      for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      return JSON.parse(decodeURIComponent(escape(text)));
    }
    throw new Error("read failed");
  });
}
function rpcCall(methodName, argsObj) {
  return new Promise(function (resolve, reject) {
    var settled = false, failed = 0, lastErr = null;
    RPC_URLS.forEach(function (url) {
      rpcCallVia(url, methodName, argsObj).then(function (v) { if (!settled) { settled = true; resolve(v); } },
        function (err) { lastErr = err; failed += 1; if (failed >= RPC_URLS.length && !settled) { settled = true; reject(lastErr || new Error("read failed")); } });
    });
  });
}
function viewAccountVia(rpcUrl, accountId) {
  return fetchWithTimeout(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gavel-view", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } })
  }, 20000).then(function (resp) { return resp.json(); }).then(function (json) {
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

/* ================= Player seat (signed by the relay) =================
   A seat is a ready-made account. A name always maps to the same seat
   account, so a returning player keeps their seat and their chips.
   The seat's private key is NOT in this page and NOT in the repo: it
   lives only in the relay (a server function), which signs each move
   on the player's behalf. This page never sees a key. The relay is
   /api/relay (same origin). */
var _savedName = storeGet("gavelName") || "";
var _savedAccount = _savedName ? storeGet("gavelAccount:" + _savedName) : null;
var player = { name: _savedName, accountId: _savedAccount, balance: null, canClaim: null, ready: !!_savedAccount, ensuring: null };

function relayCall(method, args) {
  return fetch("/api/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: player.name || "guest", method: method, args: args || {} })
  }).then(function (resp) {
    return resp.json();
  }).then(function (json) {
    if (json && json.ok) return json;
    throw new Error((json && json.error) || "relay failed");
  });
}

function ensureSeat() {
  if (player.ready && player.accountId) return Promise.resolve(player.accountId);
  if (player.ensuring) return player.ensuring;
  if (!player.name) return Promise.reject(new Error("Take a seat first — pick a name on the Room page."));
  player.ensuring = relayCall("__account_id", {}).then(function (json) {
    player.accountId = json.accountId;
    storeSet("gavelAccount:" + (player.name || "guest"), json.accountId);
    player.ready = true;
    return json.accountId;
  }, function (err) {
    throw new Error("The room could not set up your seat — the relay did not answer. Check your connection and tap again.");
  });
  player.ensuring.then(function () {}, function () { player.ensuring = null; });
  return player.ensuring;
}

function signedCall(method, args) {
  return ensureSeat().then(function () {
    return relayCall(method, args);
  });
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
