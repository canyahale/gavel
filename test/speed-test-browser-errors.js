/* Browser error-path check: after a successful claim, a second claim must
   fail via the receipt ("already claimed") with a VISIBLE message — never
   a success — and the queue must stay alive (a bid right after still lands).
   Usage: node test/speed-test-browser-errors.js */
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
  await page.goto('http://127.0.0.1:8811/index.html', { waitUntil: 'networkidle', timeout: 90000 });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);
  const name = 'Err' + Math.floor(Math.random() * 90000 + 10000);
  await page.fill('#inp-name', name);
  await page.evaluate(() => document.querySelector('#btn-seat').click());
  await page.waitForFunction(() => window.player && window.player.ready, undefined, { timeout: 90000, polling: 100 });
  const acct = await page.evaluate(() => window.player && window.player.accountId);
  // First claim: must succeed.
  await page.evaluate(() => document.querySelector('#btn-chips').click());
  await page.waitForFunction(() => {
    const m = document.querySelector('.bid-msg');
    return m && /1500 free chips are yours/.test(m.textContent);
  }, undefined, { timeout: 90000, polling: 100 });
  console.log(JSON.stringify({ accountId: acct, firstClaim: 'confirmed 1500' }));
  // Second claim: the button is disabled after a success by design, so
  // re-enable it to drive the handler's failure branch (the path a
  // retried claim takes when the first attempt's tx already landed).
  // Must fail visibly with "already claimed", never a success.
  const t2 = Date.now();
  await page.evaluate(() => { const b = document.querySelector('#btn-chips'); b.disabled = false; b.click(); });
  await page.waitForFunction(() => {
    const m = document.querySelector('.bid-msg');
    return m && /already claimed your free chips today/.test(m.textContent);
  }, undefined, { timeout: 90000, polling: 100 });
  const secondClaimMsg = await page.evaluate(() => (document.querySelector('.bid-msg') || {}).textContent);
  console.log(JSON.stringify({ secondClaimMs: Date.now() - t2, secondClaimMsg }));
  // Queue alive after the failure: bid on an affordable open lot.
  // Wait for one whose next bid is <= 1100 (of the 1500 chips) with
  // plenty of time left, and bid well above the minimum so an agent
  // bid landing during confirmation does not make this bid too low.
  await page.waitForFunction(() => {
    const l = window.currentLotCache;
    if (!l) return false;
    const next = l.bids_count === 0 ? Number(l.starting_bid) : Number(l.current_bid) + 25;
    return (Math.floor(Number(l.ends_at) / 1000000) - Date.now() > 60000) && next <= 1100 && !document.querySelector('#btn-bid').disabled;
  }, undefined, { timeout: 300000, polling: 1000 });
  const lot = await page.evaluate(() => {
    const l = window.currentLotCache;
    return { auction_id: l.auction_id, current_bid: l.current_bid, bids_count: l.bids_count, starting_bid: l.starting_bid };
  });
  const nextBid = lot.bids_count === 0 ? Number(lot.starting_bid) : Number(lot.current_bid) + 25;
  const amount = nextBid + 300;
  await page.evaluate((amt) => { document.querySelector('#inp-bid').value = String(amt); document.querySelector('#btn-bid').click(); }, amount);
  await page.waitForFunction(() => {
    const m = document.querySelector('.bid-msg');
    return m && m.textContent.indexOf('is in — you are the highest bidder') >= 0;
  }, undefined, { timeout: 90000, polling: 100 });
  const onChain = await page.evaluate(async () => {
    const open = await window.rpcCall('get_open_auctions', {});
    const l = (open || []).find(a => a.auction_id === window.currentLotCache.auction_id);
    return l ? { bidder: l.current_bidder, bid: l.current_bid, isMe: l.current_bidder === window.player.accountId } : null;
  });
  console.log(JSON.stringify({ bidAfterFailure: { auction_id: lot.auction_id, amount, onChain } }));
  console.log(JSON.stringify({ errors: errors.slice(0, 6) }));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 400)); process.exit(1); });
