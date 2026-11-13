// Redeploy The Gavel contract (bug fix: self-transfer guard + correct_balance)
// to the existing account gavel-0lycf4.testnet. State is preserved (the
// Contract struct layout is unchanged). Then report balances so the
// phantom-coin correction can be applied exactly.
const fs = require('fs');
const { connect, keyStores, KeyPair } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const CONTRACT_ID = 'gavel-0lycf4.testnet';
const WASM_PATH = '/home/hatch/workspace/gavel/contract/target/near/the_gavel.wasm';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';

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
  const auctions = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_auctions', args: {} });
  const houseSales = auctions.filter(a => a.settled && a.winner && a.seller_id === CONTRACT_ID);
  const inflation = houseSales.reduce((s, a) => s + Number(a.current_bid), 0);
  console.log('BEFORE redeploy:');
  console.log(' house balance:', before[CONTRACT_ID]);
  console.log(' Mara:', before['gavel-mara-y08d0h.testnet'], 'Bram:', before['gavel-bram-hag65w.testnet'], 'Pip:', before['gavel-pip-76rddq.testnet']);
  console.log(' total supply:', supplyBefore);
  console.log(' house sales (settled):', houseSales.map(a => `#${a.auction_id}=${a.current_bid}`).join(', '));
  console.log(' computed inflation (sum of house sale prices):', inflation);

  // Redeploy the fixed WASM (no re-init; state is preserved).
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('Redeploying WASM (' + wasm.length + ' bytes)...');
  const deployTx = await account.deployContract(wasm);
  console.log('Redeploy tx:', deployTx.transaction.hash);

  // State AFTER redeploy (should be identical — fix changes code, not state).
  const houseAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: CONTRACT_ID, token_id: 'gavel' } });
  const supplyAfter = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
  console.log('AFTER redeploy: house balance:', houseAfter, 'supply:', supplyAfter);
  console.log('STATE PRESERVED:', houseAfter === before[CONTRACT_ID] && supplyAfter === supplyBefore);

  // Apply the one-time correction: remove exactly the phantom coins.
  console.log('Correcting house balance by -' + inflation + '...');
  const correctTx = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: 'correct_balance',
    args: { account_id: CONTRACT_ID, amount: String(inflation) },
    gas: BigInt('30000000000000'),
  });
  console.log('Correct tx:', correctTx.transaction.hash);

  // Verify.
  const houseFinal = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: CONTRACT_ID, token_id: 'gavel' } });
  const supplyFinal = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
  const mara = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: 'gavel-mara-y08d0h.testnet', token_id: 'gavel' } });
  const bram = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: 'gavel-bram-hag65w.testnet', token_id: 'gavel' } });
  const pip = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'mt_balance_of', args: { account_id: 'gavel-pip-76rddq.testnet', token_id: 'gavel' } });
  const knownSum = Number(houseFinal) + Number(mara) + Number(bram) + Number(pip);
  console.log('AFTER correction:');
  console.log(' house:', houseFinal, 'Mara:', mara, 'Bram:', bram, 'Pip:', pip);
  console.log(' known sum:', knownSum, 'supply:', supplyFinal);
  console.log(' known sum + 1000 (test accounts) =', knownSum + 1000, 'vs supply', supplyFinal);
  console.log(' ACCOUNTING CONSISTENT:', knownSum + 1000 === Number(supplyFinal));
  console.log('CONTRACT_ID=' + CONTRACT_ID);
})().catch((e) => { console.error('REDEPLOY FAILED:', e); process.exit(1); });
