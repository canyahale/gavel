/* Browser verification for the Gavel speed optimization (phone viewport).
   Fresh seat -> claim -> bid on the real Room page, with per-step timings,
   honest "sent" state, confirmed-only success, and targeted balance refresh.
   Then renders Goods / Market / Leaderboard to prove the sequential-read
   change did not break the read paths.
   Local site via python http.server on 8811; RPC + helper forwarded
   through Node Playwright routes (VM Chromium cannot reach them directly).
   Usage: node test/speed-test-browser.js */
const fs = require('fs');
const { chromium } = require('/home/hatch/workspace/genesis/node_modules/playwright');
const threeJs = fs.readFileSync('/home/hatch/workspace/gavel/test/three.min.js', 'utf8');
const nearJs = fs.readFileSync('/home/hatch/workspace/gavel/test/near-api-js.min.js', 'utf8');
(async () => {
  const browser = await chromium.launch({ executablePath: '/home/hatch/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 150)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
  await page.route('**/three.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: threeJs }));
  await page.route('**/near-api-js.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: nearJs }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', async r => { try { const res = await fetch(r.request().url()); const buf = Buffer.from(await res.arrayBuffer()); r.fulfill({ status: res.status, contentType: res.headers.get('content-type') || 'image/webp', body: buf }); } catch (e) { r.abort(); } });
  const fwd = async (r, base) => { try { const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: r.request().postData() }); r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() }); } catch (e) { r.abort(); } };
  await page.route('https://rpc.testnet.fastnear.com/**', r => fwd(r, 'https://rpc.testnet.fastnear.com/'));
  await page.route('https://test.rpc.fastnear.com/**', r => fwd(r, 'https://test.rpc.fastnear.com/'));
  await page.route('https://rpc.testnet.near.org/**', r => fwd(r, 'https://rpc.testnet.near.org/'));
  await page.route('https://helper.testnet.near.org/**', async r => { try { const res = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: r.request().postData() }); r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() }); } catch (e) { r.abort(); } });

  const t0 = Date.now();
  const now = () => Date.now() - t0;
  await page.goto('http://127.0.0.1:8811/index.html', { waitUntil: 'networkidle', timeout: 90000 });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);

  // --- Seat ---
  const name = 'Speed' + Math.floor(Math.random() * 90000 + 10000);
  await page.fill('#inp-name', name);
  const seatClick = Date.now();
  await page.click('#btn-seat');
  await page.waitForFunction(() => window.player && window.player.ready, undefined, { timeout: 90000, polling: 100 });
  const seatMs = Date.now() - seatClick;
  const acct = await page.evaluate(() => window.player && window.player.accountId);
  // Give the fire-and-forget warm a moment, as a real player would.
  await page.waitForTimeout(2000);
  const warm = await page.evaluate(() => ({
    cacheKeys: Object.keys((window.seatAccount && window.seatAccount.accessKeyByPublicKeyCache) || {}),
    inFlight: window.signedCallsInFlight
  }));
  console.log(JSON.stringify({ seatMs, accountId: acct, warmCacheKeys: warm.cacheKeys, signedCallsInFlightAtRest: warm.inFlight }));

  // --- Instrument sign/broadcast/receipt + view_access_key count ---
  await page.evaluate(() => {
    window.__t = { signs: [], broadcasts: [], receipts: [], viewAccessKey: 0, sentAt: null, confirmedAt: null };
    const sa = window.seatAccount, prov = sa.connection.provider;
    const oq = prov.query.bind(prov);
    prov.query = function (a) { if (a && a.request_type === 'view_access_key') window.__t.viewAccessKey++; return oq(a); };
    const os = sa.signTransaction.bind(sa);
    sa.signTransaction = function (...a) { const s = Date.now(); if (!window.__t.signStartAt) window.__t.signStartAt = s; return os(...a).then(v => { window.__t.signs.push(Date.now() - s); return v; }, e => { window.__t.signs.push(Date.now() - s); throw e; }); };
    const ob = prov.sendTransactionAsync.bind(prov);
    prov.sendTransactionAsync = function (...a) { const s = Date.now(); if (!window.__t.broadcastStartAt) window.__t.broadcastStartAt = s; return ob(...a).then(v => { window.__t.broadcasts.push(Date.now() - s); return v; }, e => { window.__t.broadcasts.push(Date.now() - s); throw e; }); };
    const ot = prov.txStatus.bind(prov);
    prov.txStatus = function (...a) { const s = Date.now(); return ot(...a).then(v => { window.__t.receipts.push(Date.now() - s); return v; }, e => { window.__t.receipts.push(Date.now() - s); throw e; }); };
  });

  // --- Claim ---
  const claimClick = Date.now();
  await page.evaluate(() => { window.__clickAt = Date.now(); document.querySelector('#btn-chips').click(); });
  const inFlightDuringClaim = await page.evaluate(() => window.signedCallsInFlight);
  const sent = await page.waitForFunction(() => {
    const b = document.querySelector('#btn-chips');
    return b && /Claim sent/.test(b.textContent) ? Date.now() : false;
  }, undefined, { timeout: 30000, polling: 100 }).then(r => r.jsonValue()).catch(() => null);
  const sentMs = sent ? sent - claimClick : null;
  await page.waitForFunction(() => {
    const m = document.querySelector('.bid-msg');
    return m && /1500 free chips are yours/.test(m.textContent);
  }, undefined, { timeout: 90000, polling: 100 });
  const confirmedMs = Date.now() - claimClick;
  await page.waitForFunction(() => window.player && window.player.balance >= 1500, undefined, { timeout: 30000, polling: 100 });
  const balMs = Date.now() - claimClick;
  const balText = await page.evaluate(() => (document.querySelector('#bal-v') || {}).textContent);
  const claimTimings = await page.evaluate(() => window.__t);
  const inFlightAfterClaim = await page.evaluate(() => window.signedCallsInFlight);
  console.log(JSON.stringify({
    claim: { totalToConfirmedMs: confirmedMs, sentTextMs: sentMs, balanceShownMs: balMs, balanceText: balText,
      signMs: claimTimings.signs, broadcastMs: claimTimings.broadcasts,
      receiptPolls: claimTimings.receipts.length, receiptPollMs: claimTimings.receipts,
      viewAccessKeyQueries: claimTimings.viewAccessKey,
      signStartDelayMs: claimTimings.signStartAt ? claimTimings.signStartAt - claimClick : null,
      broadcastStartDelayMs: claimTimings.broadcastStartAt ? claimTimings.broadcastStartAt - claimClick : null,
      clickDispatchToSignStartMs: claimTimings.signStartAt ? claimTimings.signStartAt - (await page.evaluate(() => window.__clickAt)) : null,
      inFlightDuringClaim, inFlightAfterClaim }
  }));

  // --- Bid (one tap on the open lot) ---
  // Wait for a lot with plenty of time left, so it cannot settle mid-bid.
  await page.waitForFunction(() => {
    const l = window.currentLotCache;
    return l && (Math.floor(Number(l.ends_at) / 1000000) - Date.now() > 60000) && !document.querySelector('#btn-bid').disabled;
  }, undefined, { timeout: 120000, polling: 500 });
  const lot = await page.evaluate(() => {
    const l = window.currentLotCache;
    return l ? { auction_id: l.auction_id, current_bid: l.current_bid, bids_count: l.bids_count, starting_bid: l.starting_bid } : null;
  });
  console.log(JSON.stringify({ lotBeforeBid: lot }));
  if (lot) {
    const nextBid = lot.bids_count === 0 ? Number(lot.starting_bid) : Number(lot.current_bid) + 25;
    const balBefore = await page.evaluate(() => window.player && window.player.balance);
    const bidClick = Date.now();
    await page.evaluate(() => { window.__bidClickAt = Date.now(); document.querySelector('#btn-bid').click(); });
    // Paddle-up must be immediate (synchronous in-page feedback).
    await page.waitForTimeout(300);
    const paddleMsg = await page.evaluate(() => (document.querySelector('#bid-msg') || {}).textContent);
    await page.waitForFunction((amt) => {
      const m = document.querySelector('.bid-msg');
      return m && m.textContent.indexOf('is in — you are the highest bidder') >= 0;
    }, nextBid, { timeout: 90000, polling: 100 });
    const bidConfirmedMs = Date.now() - bidClick;
    const bidTimings = await page.evaluate(() => window.__t);
    const balAfter = await page.evaluate(() => window.player && window.player.balance);
    const onChain = await page.evaluate(async () => {
      const open = await window.rpcCall('get_open_auctions', {});
      const l = (open || []).find(a => a.auction_id === window.currentLotCache.auction_id);
      return l ? { bidder: l.current_bidder, bid: l.current_bid, isMe: l.current_bidder === window.player.accountId } : null;
    });
    console.log(JSON.stringify({
      bid: { amount: nextBid, balanceBefore: balBefore, balanceAfter: balAfter,
        paddleMsgAt300ms: paddleMsg, totalToConfirmedMs: bidConfirmedMs,
        signMs: bidTimings.signs.slice(1), broadcastMs: bidTimings.broadcasts.slice(1),
        receiptPollsTotal: bidTimings.receipts.length,
        viewAccessKeyQueriesTotal: bidTimings.viewAccessKey, onChain }
    }));
  }

  // --- Other pages still render (sequential reads) ---
  async function renderCheck(url, sel, label) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 120));
    console.log(JSON.stringify({ page: label, matches: n, snippet: txt.replace(/\n/g, ' | ').slice(0, 120) }));
  }
  await renderCheck('http://127.0.0.1:8811/goods.html', '#goods-wrap .good', 'goods');
  await renderCheck('http://127.0.0.1:8811/market.html', '#market-grid .good', 'market');
  await renderCheck('http://127.0.0.1:8811/leaderboard.html', '#board-wrap .bidder, #board-wrap table tr', 'leaderboard');

  console.log(JSON.stringify({ errors: errors.slice(0, 6) }));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 400)); process.exit(1); });
