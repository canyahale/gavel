// Redeploy The Gavel contract with FAUCET_AMOUNT 500 -> 1500.
// State is preserved: only a compile-time constant changed, the
// Contract struct layout is untouched, so no migration is needed.
// No season re-init (season 1 is already running).
// Verifies state before/after; small differences are expected only
// if the live bot settles a lot or pays income during the deploy.
const fs = require('fs');
const { connect, keyStores, KeyPair } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const WASM_PATH = '/home/hatch/workspace/gavel/contract/target/near/the_gavel.wasm';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';

(async () => {
  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  const kp = KeyPair.fromString(keys[CONTRACT_ID].private_key);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', CONTRACT_ID, kp);
  const near = await connect({
    networkId: 'testnet',
    keyStore,
    nodeUrl: 'https://rpc.testnet.fastnear.com',
    walletUrl: 'https://testnet.mynearwallet.com',
    helperUrl: 'https://helper.testnet.near.org',
  });
  const account = await near.account(CONTRACT_ID);

  async function snapshot(label) {
    const s = {};
    for (const id of [CONTRACT_ID, 'gavel-mara-y08d0h.testnet', 'gavel-bram-hag65w.testnet', 'gavel-pip-76rddq.testnet']) {
      s[id] = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: id, token_id: 'gavel' } });
    }
    s.supply = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
    s.pool = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_prize_pool', args: {} });
    const goods = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_goods', args: {} });
    s.goods = goods.length;
    const auctions = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_auctions', args: {} });
    s.auctions = auctions.length;
    const open = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_open_auctions', args: {} });
    s.open = open.length;
    s.season = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_season_info', args: {} });
    console.log(label, JSON.stringify(s, null, 1));
    return s;
  }

  const before = await snapshot('BEFORE redeploy:');
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('Redeploying WASM (' + wasm.length + ' bytes)...');
  const deployTx = await account.deployContract(wasm);
  console.log('Redeploy tx:', deployTx.transaction.hash);
  const after = await snapshot('AFTER redeploy:');
  const structural = after.goods === before.goods && after.auctions === before.auctions && after.season.season_id === before.season.season_id && after.season.ends_at === before.season.ends_at;
  const balancesSane = [CONTRACT_ID, 'gavel-mara-y08d0h.testnet', 'gavel-bram-hag65w.testnet', 'gavel-pip-76rddq.testnet'].every(id => Number(after[id]) > 0);
  console.log('STRUCTURE PRESERVED (goods/auctions/season):', structural);
  console.log('BALANCES SANE (all > 0):', balancesSane);
  console.log('supply before->after:', before.supply, '->', after.supply, '| pool:', before.pool, '->', after.pool, '| open lots:', before.open, '->', after.open);
  if (!structural || !balancesSane) { console.error('STATE MISMATCH — STOP'); process.exit(1); }
  console.log('REDEPLOY OK');
})().catch((e) => { console.error('REDEPLOY FAILED:', e); process.exit(1); });
