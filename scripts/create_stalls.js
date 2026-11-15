// Create two new cheap stalls (owner-only create_good, signed as the
// contract/house account) to replace stall-1 and stall-2, which are locked
// in dead browser test accounts with no reclaim path. New stalls are the
// cheapest items in the game, so a new player with one day's faucet
// (1,500) can outbid even the AI's maximum valuation on them.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair } = require('near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const KEYS_PATH = path.join(__dirname, '..', '.testnet-accounts.json');

const NEW_GOODS = [
  { good_id: 'stall-3', name: 'Flower Stall', kind: 'stall', income_per_day: '50' },
  { good_id: 'stall-4', name: 'Herb Stall', kind: 'stall', income_per_day: '70' },
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
  for (const g of goods) console.log(' -', g.good_id, g.name, g.income_per_day + '/day', 'owner', g.owner_id);
})().catch(e => { console.error('FAILED:', e.message.slice(0, 300)); process.exit(1); });
