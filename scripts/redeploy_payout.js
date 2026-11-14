// Redeploy The Gavel contract (prize-pool payout: daily seasons,
// top 3 owners split the pool 50/30/20) to the existing account
// gavel-0lycf4.testnet. State is preserved: the Contract struct
// layout is unchanged (season + payout live under separate storage
// keys), so no migration is needed. Then verify the new views and
// start season 1.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair } = require('near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const WASM_PATH = path.join(__dirname, '..', 'contract', 'target', 'near', 'the_gavel.wasm');
const KEYS_PATH = path.join(__dirname, '..', '.testnet-accounts.json');

(async () => {
  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  const ownerKey = keys[CONTRACT_ID];
  const kp = KeyPair.fromString(ownerKey.private_key);
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

  // State BEFORE redeploy.
  const before = {};
  for (const id of [CONTRACT_ID, 'gavel-mara-y08d0h.testnet', 'gavel-bram-hag65w.testnet', 'gavel-pip-76rddq.testnet']) {
    before[id] = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: id, token_id: 'gavel' } });
  }
  const supplyBefore = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
  const poolBefore = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_prize_pool', args: {} });
  const goodsBefore = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_goods', args: {} });
  console.log('BEFORE redeploy:');
  console.log(' house:', before[CONTRACT_ID], 'Mara:', before['gavel-mara-y08d0h.testnet'], 'Bram:', before['gavel-bram-hag65w.testnet'], 'Pip:', before['gavel-pip-76rddq.testnet']);
  console.log(' total supply:', supplyBefore, 'prize pool:', poolBefore, 'goods:', goodsBefore.length);

  // Redeploy the new WASM (no re-init; state is preserved).
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('Redeploying WASM (' + wasm.length + ' bytes)...');
  const deployTx = await account.deployContract(wasm);
  console.log('Redeploy tx:', deployTx.transaction.hash);

  // State AFTER redeploy (should be identical).
  const houseAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: CONTRACT_ID, token_id: 'gavel' } });
  const supplyAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
  const poolAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_prize_pool', args: {} });
  const goodsAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_goods', args: {} });
  console.log('AFTER redeploy: house:', houseAfter, 'supply:', supplyAfter, 'pool:', poolAfter, 'goods:', goodsAfter.length);
  const preserved = houseAfter === before[CONTRACT_ID] && supplyAfter === supplyBefore && poolAfter === poolBefore && goodsAfter.length === goodsBefore.length;
  console.log('STATE PRESERVED:', preserved);
  if (!preserved) { console.error('STATE MISMATCH — STOP'); process.exit(1); }

  // New payout views must exist.
  const season = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_season_info', args: {} });
  console.log('Season info:', JSON.stringify(season));
  const board = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_leaderboard', args: {} });
  console.log('Leaderboard:', JSON.stringify(board));
  const lastPayout = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_last_payout', args: {} });
  console.log('Last payout:', JSON.stringify(lastPayout));

  // Start season 1: first payout call initialises the season and
  // returns null (season has not ended yet).
  const initTx = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: 'payout_prize_pool',
    args: {},
    gas: BigInt('30000000000000'),
  });
  console.log('Season-start tx:', initTx.transaction.hash);
  const season2 = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_season_info', args: {} });
  console.log('Season info after start:', JSON.stringify(season2));
  console.log('CONTRACT_ID=' + CONTRACT_ID);
})().catch((e) => { console.error('REDEPLOY FAILED:', e); process.exit(1); });
