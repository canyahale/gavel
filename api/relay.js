"use strict";
/* Gavel relay — hides the pool private keys from the public frontend.
 *
 * The frontend never sees a pool key. It POSTs { name, method, args }.
 * The relay maps the display name to a pool account (same hash as the
 * frontend's poolEntryFor), loads that account's key from the
 * GAVEL_POOL env var, and signs + submits the contract call.
 *
 * Env: GAVEL_POOL = JSON string of
 *   [{ "a": "<account>.testnet", "k": "ed25519:<private key>" }, ...]
 * Keys live ONLY in that env var — never in this file, the repo, or a
 * reply. This file contains no key material.
 *
 * Request:  POST { name, method, args }
 *   method "__account_id" -> { ok:true, accountId } (no transaction)
 *   one of the 10 change methods -> { ok:true, txHash }
 *   anything else -> 400 { ok:false, error }
 *   relay not configured (env missing/unparseable) -> 500
 *   transaction / RPC failure -> 200 { ok:false, error }
 */
const { connect, keyStores, KeyPair } = require("near-api-js");

const CONTRACT_ID = "gavel-0lycf4.testnet";
const GAS = BigInt("30000000000000"); // 3e13, same as the frontend
const RPC_URLS = [
  "https://rpc.testnet.near.org",
  "https://rpc.testnet.fastnear.com",
  "https://test.rpc.fastnear.com",
];
const CHANGE_METHODS = new Set([
  "claim_faucet",
  "place_bid",
  "open_auction",
  "settle_auction",
  "claim_income",
  "buy_share",
  "sell_share",
  "list_good",
  "buy_good",
  "delist_good",
]);

/* Same hash as index.html poolEntryFor: h=0; for each char c,
 * h = ((h<<5)-h + charCode(c))|0; index = Math.abs(h) % POOL.length. */
function poolEntryFor(pool, name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return pool[Math.abs(h) % pool.length];
}

function loadPool() {
  const raw = process.env.GAVEL_POOL;
  if (!raw) return null;
  try {
    const pool = JSON.parse(raw);
    if (!Array.isArray(pool) || pool.length === 0) return null;
    for (const e of pool) {
      if (!e || typeof e.a !== "string" || typeof e.k !== "string") return null;
    }
    return pool;
  } catch (e) {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel may already have parsed the body for us.
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === "string") {
        try {
          resolve(JSON.parse(req.body));
        } catch (e) {
          reject(e);
        }
      } else {
        resolve(req.body);
      }
      return;
    }
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function shortError(err) {
  const m = err && err.message ? String(err.message) : "relay failed";
  return m.length > 200 ? m.slice(0, 200) : m;
}

/* Pick the first RPC that answers a read-only status query, then submit
 * exactly once through it. This avoids ever submitting the same
 * transaction twice when an endpoint is down. */
async function connectHealthy(keyStore) {
  let lastErr = null;
  for (const url of RPC_URLS) {
    try {
      const near = await connect({
        networkId: "testnet",
        keyStore,
        nodeUrl: url,
        headers: {},
      });
      await near.connection.provider.status();
      return near;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all RPC endpoints unreachable");
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "invalid JSON body" });
    return;
  }

  const name = body && body.name;
  const method = body && body.method;
  const args =
    body && body.args && typeof body.args === "object" ? body.args : {};

  if (typeof name !== "string" || !name) {
    sendJson(res, 400, { ok: false, error: "name is required" });
    return;
  }
  if (
    typeof method !== "string" ||
    (method !== "__account_id" && !CHANGE_METHODS.has(method))
  ) {
    sendJson(res, 400, { ok: false, error: "method not allowed" });
    return;
  }

  const pool = loadPool();
  if (!pool) {
    sendJson(res, 500, { ok: false, error: "relay not configured" });
    return;
  }
  const entry = poolEntryFor(pool, name);
  if (!entry) {
    sendJson(res, 500, { ok: false, error: "relay not configured" });
    return;
  }

  // Read-only: return the pool account id for this name. No signing,
  // no keypair, no transaction.
  if (method === "__account_id") {
    sendJson(res, 200, { ok: true, accountId: entry.a });
    return;
  }

  // Change method: sign + submit as the pool account.
  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("testnet", entry.a, KeyPair.fromString(entry.k));
    const near = await connectHealthy(keyStore);
    const account = await near.account(entry.a);
    const outcome = await account.functionCall({
      contractId: CONTRACT_ID,
      methodName: method,
      args,
      gas: GAS,
      attachedDeposit: BigInt(0),
    });
    const txHash =
      outcome && outcome.transaction && outcome.transaction.hash
        ? outcome.transaction.hash
        : "";
    sendJson(res, 200, { ok: true, txHash });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: shortError(err) });
  }
};
