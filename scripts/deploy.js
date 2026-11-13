// Deploy The Gavel contract to a fresh NEAR testnet account, create the
// 8 goods, create 3 AI bidder accounts and fund their starting bankrolls.
// Saves keys to ~/workspace/gavel/.testnet-accounts.json (chmod 600).
// Keys are never printed.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair, utils } = require('/home/hatch/workspace/merit/node_modules/near-api-js');

const WASM_PATH = '/home/hatch/workspace/gavel/contract/target/near/the_gavel.wasm';
const KEYS_PATH = '/home/hatch/workspace/gavel/.testnet-accounts.json';
const HELPER_URL = 'https://helper.testnet.near.org/account';

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function createAccount(accountId, publicKey) {
  const res = await fetch(HELPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`helper ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const GOODS = [
  { good_id: 'stall-1', name: 'Corner Stall', kind: 'stall', income_per_day: '60' },
  { good_id: 'stall-2', name: 'Spice Stall', kind: 'stall', income_per_day: '80' },
  { good_id: 'route-1', name: 'River Route', kind: 'route', income_per_day: '100' },
  { good_id: 'route-2', name: 'Mountain Route', kind: 'route', income_per_day: '140' },
  { good_id: 'recipe-1', name: "Healer's Recipe", kind: 'recipe', income_per_day: '120' },
  { good_id: 'recipe-2', name: "Smith's Recipe", kind: 'recipe', income_per_day: '160' },
  { good_id: 'relic-1', name: 'Sun Relic', kind: 'relic', income_per_day: '200' },
  { good_id: 'relic-2', name: 'Moon Relic', kind: 'relic', income_per_day: '250' },
];

// AI bidders: name, personality, starting bankroll (Gavel Coins).
const BIDDERS = [
  { name: 'Mara', accountSuffix: 'mara', bankroll: '3000' },
  { name: 'Bram', accountSuffix: 'bram', bankroll: '2500' },
  { name: 'Pip', accountSuffix: 'pip', bankroll: '1200' },
];

(async () => {
  const keyStore = new keyStores.InMemoryKeyStore();
  const keys = {};

  async function makeAccount(prefix) {
    const accountId = `${prefix}-${randomSuffix()}.testnet`;
    const kp = KeyPair.fromRandom('ed25519');
    const pub = kp.getPublicKey().toString();
    console.log('Creating account:', accountId);
    await createAccount(accountId, pub);
    await keyStore.setKey('testnet', accountId, kp);
    keys[accountId] = { account_id: accountId, public_key: pub, private_key: kp.toString() };
    return accountId;
  }

  // 1. Contract account.
  const contractId = await makeAccount('gavel');
  const config = {
    networkId: 'testnet',
    keyStore,
    nodeUrl: 'https://rpc.testnet.fastnear.com',
    walletUrl: 'https://testnet.mynearwallet.com',
    helperUrl: 'https://helper.testnet.near.org',
    explorerUrl: 'https://testnet.nearblocks.io',
  };
  const near = await connect(config);
  const contractAccount = await near.account(contractId);
  const bal = await contractAccount.getAccountBalance();
  console.log('Contract account balance:', utils.format.formatNearAmount(bal.available), 'NEAR');

  // 2. Deploy WASM.
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('Deploying WASM (' + wasm.length + ' bytes)...');
  const deployTx = await contractAccount.deployContract(wasm);
  console.log('Deploy tx:', deployTx.transaction.hash);

  // 3. Init.
  console.log('Initialising contract...');
  const initTx = await contractAccount.functionCall({
    contractId,
    methodName: 'new',
    args: { owner_id: contractId, treasury: contractId },
    gas: BigInt('30000000000000'),
  });
  console.log('Init tx:', initTx.transaction.hash);

  // Helper to call a change method as the contract owner.
  async function call(method, args, gas = '30000000000000') {
    const tx = await contractAccount.functionCall({
      contractId,
      methodName: method,
      args,
      gas: BigInt(gas),
    });
    return tx;
  }

  // 4. Create the 8 goods.
  for (const g of GOODS) {
    const tx = await call('create_good', g);
    console.log('Created good', g.good_id, 'tx', tx.transaction.hash);
  }

  // 5. AI bidder accounts + bankrolls.
  const bidderInfo = [];
  for (const b of BIDDERS) {
    const accountId = await makeAccount(`gavel-${b.accountSuffix}`);
    const tx = await call('seed_bankroll', { account_id: accountId, amount: b.bankroll });
    console.log('Seeded', b.name, accountId, b.bankroll, 'coins, tx', tx.transaction.hash);
    bidderInfo.push({ name: b.name, account_id: accountId, bankroll: b.bankroll });
  }

  // Save keys (chmod 600).
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  fs.chmodSync(KEYS_PATH, 0o600);
  console.log('Keys saved to', KEYS_PATH, '(chmod 600)');

  // 6. Verify on-chain.
  const goods = await contractAccount.viewFunction({ contractId, methodName: 'get_goods', args: {} });
  console.log('GOODS ON CHAIN:', goods.length);
  for (const g of goods) {
    console.log(' -', g.good_id, g.name, g.kind, 'income/day', g.income_per_day, 'owner', g.owner_id);
  }
  const supply = await contractAccount.viewFunction({ contractId, methodName: 'mt_total_supply', args: { token_id: 'gavel' } });
  console.log('TOTAL SUPPLY:', supply);
  for (const b of bidderInfo) {
    const bal = await contractAccount.viewFunction({ contractId, methodName: 'mt_balance_of', args: { account_id: b.account_id, token_id: 'gavel' } });
    console.log('BIDDER', b.name, b.account_id, 'balance', bal);
  }
  console.log('CONTRACT_ID=' + contractId);
  console.log(JSON.stringify({ contract_id: contractId, bidders: bidderInfo }));
})().catch((e) => {
  console.error('DEPLOY FAILED:', e);
  process.exit(1);
});
