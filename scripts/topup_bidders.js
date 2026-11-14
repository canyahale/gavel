// Top up the three AI bidders so the room stays lively.
// Uses the owner-only seed_bankroll (it mints coins). Run once.
const { connect, keyStores, KeyPair } = require('near-api-js');
const fs = require('fs');
const path = require('path');
const CONTRACT_ID = 'gavel-0lycf4.testnet';
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.testnet-accounts.json'), 'utf8'));

async function main() {
  const ownerKey = ACCOUNTS[CONTRACT_ID] || ACCOUNTS['gavel-0lycf4.testnet'];
  if (!ownerKey || !ownerKey.private_key) throw new Error('Missing owner key for ' + CONTRACT_ID);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(ownerKey.private_key));
  const near = await connect({ networkId: 'testnet', keyStore, nodeUrl: 'https://rpc.testnet.fastnear.com' });
  const account = await near.account(CONTRACT_ID);
  const contract = new (require('near-api-js').Contract)(account, CONTRACT_ID, {
    viewMethods: ['mt_balance_of', 'mt_total_supply'],
    changeMethods: ['seed_bankroll'],
    useLocalViewExecution: false
  });
  const topups = [
    ['gavel-mara-y08d0h.testnet', 1500],
    ['gavel-bram-hag65w.testnet', 1500],
    ['gavel-pip-76rddq.testnet', 1200]
  ];
  for (const [id, amount] of topups) {
    const before = await contract.mt_balance_of({ account_id: id, token_id: 'gavel' });
    await contract.seed_bankroll({ account_id: id, amount: amount.toString() }, BigInt('30000000000000'), BigInt(0));
    const after = await contract.mt_balance_of({ account_id: id, token_id: 'gavel' });
    console.log(id, 'balance', before, '->', after, '(+' + amount + ')');
  }
  const supply = await contract.mt_total_supply({ token_id: 'gavel' });
  console.log('total supply now:', supply);
}
main().catch(e => { console.error('TOPUP FAILED:', e.message); process.exit(1); });
