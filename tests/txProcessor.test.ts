import eventTemplate from '@events/eventTemplate.json';
import * as txProcessor from '@src/txProcessor';
import { Balance, TokenBalanceMap, Utxo } from '@src/types.ts';
import { closeDbConnection, getDbConnection } from '@src/utils';
import {
  addToAddressTable,
  addToAddressBalanceTable,
  addToUtxoTable,
  addToWalletTable,
  addToWalletBalanceTable,
  cleanDatabase,
  checkUtxoTable,
  checkAddressTable,
  checkAddressBalanceTable,
  checkAddressTxHistoryTable,
  checkWalletBalanceTable,
  createOutput,
  createInput,
} from '@tests/utils';

const mysql = getDbConnection();
const blockReward = 6400;
const OLD_ENV = process.env;

beforeEach(async () => {
  await cleanDatabase(mysql);
});

beforeAll(async () => {
  // modify env so block reward is unlocked after 1 new block (overrides .env file)
  jest.resetModules();
  process.env = { ...OLD_ENV };
  process.env.BLOCK_REWARD_LOCK = '1';
});

afterAll(async () => {
  await closeDbConnection(mysql);
  // restore old env
  process.env = OLD_ENV;
});

test('getAddressBalanceMap', () => {
  expect.hasAssertions();
  const evt = JSON.parse(JSON.stringify(eventTemplate));
  const tx = evt.Records[0].body;
  const now = 20000;
  tx.tx_id = 'txId1';
  tx.timestamp = 0;
  tx.inputs = [
    createInput(10, 'address1', 'inputTx', 0, 'token1'),
    createInput(5, 'address1', 'inputTx', 0, 'token1'),
    createInput(7, 'address1', 'inputTx', 1, 'token2'),
    createInput(3, 'address2', 'inputTx', 2, 'token1'),
  ];
  tx.outputs = [
    createOutput(5, 'address1', 'token1'),
    createOutput(2, 'address1', 'token3'),
    createOutput(11, 'address2', 'token1'),
  ];
  const map1 = new TokenBalanceMap();
  map1.set('token1', new Balance(-10, 0));
  map1.set('token2', new Balance(-7, 0));
  map1.set('token3', new Balance(2, 0));
  const map2 = new TokenBalanceMap();
  map2.set('token1', new Balance(8, 0));
  const expectedAddrMap = {
    address1: map1,
    address2: map2,
  };
  const addrMap = txProcessor.getAddressBalanceMap(tx.inputs, tx.outputs, now);
  expect(addrMap).toStrictEqual(expectedAddrMap);

  // update tx to contain outputs with timelock
  tx.outputs[0].decoded.timelock = now - 1;   // won't be locked
  tx.outputs[1].decoded.timelock = now;       // won't be locked
  tx.outputs[2].decoded.timelock = now + 1;   // locked
  map2.set('token1', new Balance(-3, 11));
  const addrMap2 = txProcessor.getAddressBalanceMap(tx.inputs, tx.outputs, now);
  expect(addrMap2).toStrictEqual(expectedAddrMap);

  // a block will have its rewards locked, even with no timelock
  tx.inputs = [];
  tx.outputs = [
    createOutput(100, 'address1', 'token1'),
  ];
  const addrMap3 = txProcessor.getAddressBalanceMap(tx.inputs, tx.outputs, now, true);
  const map3 = new TokenBalanceMap();
  map3.set('token1', new Balance(0, 100));
  const expectedAddrMap2 = {
    address1: map3,
  };
  expect(addrMap3).toStrictEqual(expectedAddrMap2);
});

test('getWalletBalanceMap', () => {
  expect.hasAssertions();
  const mapAddress1 = new TokenBalanceMap();
  mapAddress1.set('token1', new Balance(-10, 0));
  mapAddress1.set('token2', new Balance(-7, 0));
  mapAddress1.set('token3', new Balance(2, 0));
  const mapAddress2 = new TokenBalanceMap();
  mapAddress2.set('token1', new Balance(8, 0));
  const mapAddress3 = new TokenBalanceMap();
  mapAddress3.set('token2', new Balance(2, 0));
  mapAddress3.set('token3', new Balance(6, 0));
  const mapAddress4 = new TokenBalanceMap();
  mapAddress4.set('token1', new Balance(2, 0));
  mapAddress4.set('token2', new Balance(9, 0));
  const mapAddress5 = new TokenBalanceMap();
  mapAddress5.set('token1', new Balance(11, 0));
  const addressBalanceMap = {
    address1: mapAddress1,
    address2: mapAddress2,
    address3: mapAddress3,
    address4: mapAddress4,
    address5: mapAddress5,    // doesn't belong to any started wallet
  };
  const walletAddressMap = {
    address1: { walletId: 'wallet1', xpubkey: 'xpubkey1', maxGap: 5 },
    address2: { walletId: 'wallet1', xpubkey: 'xpubkey1', maxGap: 5 },
    address4: { walletId: 'wallet1', xpubkey: 'xpubkey1', maxGap: 5 },
    address3: { walletId: 'wallet2', xpubkey: 'xpubkey2', maxGap: 5 },
  };
  const mapWallet1 = new TokenBalanceMap();
  mapWallet1.set('token1', new Balance(0, 0));
  mapWallet1.set('token2', new Balance(2, 0));
  mapWallet1.set('token3', new Balance(2, 0));
  const mapWallet2 = new TokenBalanceMap();
  mapWallet2.set('token2', new Balance(2, 0));
  mapWallet2.set('token3', new Balance(6, 0));
  const expectedWalletBalanceMap = {
    wallet1: mapWallet1,
    wallet2: mapWallet2,
  };
  const walletBalanceMap = txProcessor.getWalletBalanceMap(walletAddressMap, addressBalanceMap);
  expect(walletBalanceMap).toStrictEqual(expectedWalletBalanceMap);

  // if walletAddressMap is empty, should also return an empty object
  const walletBalanceMap2 = txProcessor.getWalletBalanceMap({}, addressBalanceMap);
  expect(walletBalanceMap2).toStrictEqual({});
});

test('unlockUtxos', async () => {
  expect.hasAssertions();
  const reward = 6400;
  const txId1 = 'txId1';
  const txId2 = 'txId2';
  const txId3 = 'txId3';
  const token = 'tokenId';
  const addr = 'address';
  const walletId = 'walletId';
  const now = 1000;
  await addToUtxoTable(mysql, [
    // blocks with heightlock
    [txId1, 0, token, addr, reward, null, 3],
    [txId2, 0, token, addr, reward, null, 4],
    // some transaction with timelock
    [txId3, 0, token, addr, 5000, now, null],
  ]);

  await addToWalletTable(mysql, [
    [walletId, 'xpub', 'ready', 10, 1000, 1000],
  ]);

  await addToAddressTable(mysql, [
    [addr, 0, walletId, 1],
  ]);

  await addToAddressBalanceTable(mysql, [
    [addr, token, 0, 2 * reward + 5000, 3],
  ]);

  await addToWalletBalanceTable(mysql, [
    [walletId, token, 0, 2 * reward + 5000, 3],
  ]);

  const utxo: Utxo = {
    txId: txId1,
    index: 0,
    tokenId: token,
    address: addr,
    value: reward,
    timelock: null,
    heightlock: 3,
  };

  await txProcessor.unlockUtxos(mysql, [utxo], now);
  await expect(checkAddressBalanceTable(mysql, 1, addr, token, reward, reward + 5000, 3)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 1, walletId, token, reward, reward + 5000, 3)).resolves.toBe(true);

  utxo.txId = txId2;
  utxo.heightlock = 4;
  await txProcessor.unlockUtxos(mysql, [utxo], now);
  await expect(checkAddressBalanceTable(mysql, 1, addr, token, 2 * reward, 5000, 3)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 1, walletId, token, 2 * reward, 5000, 3)).resolves.toBe(true);

  utxo.txId = txId3;
  utxo.value = 5000;
  utxo.heightlock = 5;
  utxo.timelock = now;
  utxo.heightlock = null;
  await txProcessor.unlockUtxos(mysql, [utxo], now);
  await expect(checkAddressBalanceTable(mysql, 1, addr, token, 2 * reward + 5000, 0, 3)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 1, walletId, token, 2 * reward + 5000, 0, 3)).resolves.toBe(true);
});

/*
 * receive some transactions and blocks and make sure database is correct
 */
test('txProcessor', async () => {
  expect.hasAssertions();
  const blockRewardLock = parseInt(process.env.BLOCK_REWARD_LOCK, 10);

  // receive a block
  const evt = JSON.parse(JSON.stringify(eventTemplate));
  const block = evt.Records[0].body;
  block.version = 0;
  block.tx_id = 'txId1';
  block.height = 1;
  block.inputs = [];
  block.outputs = [createOutput(blockReward, 'address1')];
  await txProcessor.onNewTxEvent(evt);
  // check databases
  await expect(checkUtxoTable(mysql, 1, 'txId1', 0, '00', 'address1', blockReward, null, block.height + blockRewardLock)).resolves.toBe(true);
  await expect(checkAddressTable(mysql, 1, 'address1', null, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 1, 'address1', '00', 0, blockReward, 1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 1, 'address1', 'txId1', '00', blockReward, block.timestamp)).resolves.toBe(true);

  // receive another block, for the same address
  block.tx_id = 'txId2';
  block.timestamp += 10;
  block.height += 1;
  await txProcessor.onNewTxEvent(evt);
  // we now have 2 blocks, still only 1 address
  await expect(checkUtxoTable(mysql, 2, 'txId2', 0, '00', 'address1', blockReward, null, block.height + blockRewardLock)).resolves.toBe(true);
  await expect(checkAddressTable(mysql, 1, 'address1', null, null, 2)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 1, 'address1', '00', blockReward, blockReward, 2)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 2, 'address1', 'txId2', '00', blockReward, block.timestamp)).resolves.toBe(true);

  // receive another block, for a different address
  block.tx_id = 'txId3';
  block.timestamp += 10;
  block.height += 1;
  block.outputs = [createOutput(blockReward, 'address2')];
  await txProcessor.onNewTxEvent(evt);
  // we now have 3 blocks and 2 addresses
  await expect(checkUtxoTable(mysql, 3, 'txId3', 0, '00', 'address2', blockReward, null, block.height + blockRewardLock)).resolves.toBe(true);
  await expect(checkAddressTable(mysql, 2, 'address2', null, null, 1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 3, 'address2', 'txId3', '00', blockReward, block.timestamp)).resolves.toBe(true);
  // new block reward is locked
  await expect(checkAddressBalanceTable(mysql, 2, 'address2', '00', 0, blockReward, 1)).resolves.toBe(true);
  // address1's balance is all unlocked now
  await expect(checkAddressBalanceTable(mysql, 2, 'address1', '00', 2 * blockReward, 0, 2)).resolves.toBe(true);

  // spend first block to 2 other addresses
  const tx = evt.Records[0].body;
  tx.version = 1;
  tx.tx_id = 'txId4';
  tx.timestamp += 10;
  tx.inputs = [createInput(blockReward, 'address1', 'txId1', 0)];
  tx.outputs = [
    createOutput(5, 'address3'),
    createOutput(blockReward - 5, 'address4'),
  ];
  await txProcessor.onNewTxEvent(evt);
  for (const [index, output] of tx.outputs.entries()) {
    const { token, decoded, value } = output;
    // we now have 4 utxos (had 3, 2 added and 1 removed)
    await expect(checkUtxoTable(mysql, 4, tx.tx_id, index, token, decoded.address, value, decoded.timelock, null)).resolves.toBe(true);
    // the 2 addresses on the outputs have been added to the address table, with null walletId and index
    await expect(checkAddressTable(mysql, 4, decoded.address, null, null, 1)).resolves.toBe(true);
    // there are 4 different addresses with some balance
    await expect(checkAddressBalanceTable(mysql, 4, decoded.address, token, value, 0, 1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 6, decoded.address, tx.tx_id, token, value, tx.timestamp)).resolves.toBe(true);
  }
  for (const input of tx.inputs) {
    const { decoded, token, value } = input;
    // the input will have a negative amount in the address_tx_history table
    await expect(checkAddressTxHistoryTable(mysql, 6, decoded.address, tx.tx_id, token, (-1) * value, tx.timestamp)).resolves.toBe(true);
  }
  // address1 balance has decreased
  await expect(checkAddressBalanceTable(mysql, 4, 'address1', '00', blockReward, 0, 3)).resolves.toBe(true);
  // address2 balance is still locked
  await expect(checkAddressBalanceTable(mysql, 4, 'address2', '00', 0, blockReward, 1)).resolves.toBe(true);
});
