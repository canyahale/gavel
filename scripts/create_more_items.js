// Add four more items to grow the economy from 12 to 16, filling the
// income gaps (90, 180, 220, 350). Same owner-only create_good path as
// create_stalls.js. Capped starting bids (2x income) stay under the 1,500
// faucet: 180, 360, 440, 700.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair } = require('near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const KEYS_PATH = path.join(__dirname, '..', '.testnet-accounts.json');

const NEW_GOODS = [
  { good_id: 'stall-5', name: 'Tea Stall', kind: 'stall', income_per_day: '90' },
  { good_id: 'recipe-3', name: "Baker's Recipe", kind: 'recipe', income_per_day: '180' },
  { good_id: 'route-3', name: 'Forest Route', kind: 'route', income_per_day: '220' },
  { good_id: 'relic-5', name: 'Star Relic', kind: 'relic', income_per_day: '350' },
];

(async () => {
  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  const entry = keys[CONTRACT_ID];
  if (!entry) throw new Error('contract account key not in ' + KEYS_PATH);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(entry.private_key));
  const near = await connect({ networkId: 'testnet', keyStore, nodeUrl: 'https://rpc.testnet.fastnear.com', walletUrl: 'https://testnet.mynearwallet.com', helperUrl: 'https://helper.testnet.near.org' });
  const account = await near.account(CONTRACT_ID);
  for (const g of NEW_GOODS) {
    const tx = await account.functionCall({ contractId: CONTRACT_ID, methodName: 'create_good', args: g, gas: BigInt('30000000000000') });
    console.log('Created', g.good_id, g.name, g.income_per_day + '/day', 'tx', tx.transaction.hash);
  }
  const goods = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_goods', args: {} });
  console.log('GOODS ON CHAIN:', goods.length);
  for (const g of goods) console.log(' -', g.good_id, g.name, g.income_per_day + '/day', 'owner', g.owner_id.slice(0, 25));
})().catch(e => { console.error('FAILED:', e.message.slice(0, 300)); process.exit(1); });
