import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';

import { get as addressesGet } from '@src/api/addresses';
import { get as balancesGet } from '@src/api/balances';
import { get as txHistoryGet } from '@src/api/txhistory';
import { get as walletGet, create as walletCreate } from '@src/api/wallet';
import { ApiError } from '@src/api/errors';
import { closeDbConnection, getDbConnection, getWalletId } from '@src/utils';
import {
  XPUBKEY,
  addToAddressTable,
  addToWalletBalanceTable,
  addToWalletTable,
  addToWalletTxHistoryTable,
  cleanDatabase,
  makeGatewayEvent,
} from '@tests/utils';

const mysql = getDbConnection();

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

const _testMissingParam = async (fn: APIGatewayProxyHandler, paramName: string, params = {}) => {
  const event = makeGatewayEvent(params);
  const result = await fn(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.MISSING_PARAMETER);
  expect(returnBody.parameter).toBe(paramName);
};

const _testInvalidParam = async (fn: APIGatewayProxyHandler, paramName: string, params) => {
  const event = makeGatewayEvent(params);
  const result = await fn(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.INVALID_PARAMETER);
  expect(returnBody.parameter).toBe(paramName);
};

const _testMissingWallet = async (fn: APIGatewayProxyHandler, walletId: string) => {
  const event = makeGatewayEvent({ id: walletId });
  const result = await fn(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.WALLET_NOT_FOUND);
};

const _testWalletNotReady = async (fn: APIGatewayProxyHandler) => {
  const walletId = 'wallet-not-started';
  await addToWalletTable(mysql, [[walletId, 'aaaa', 'creating', 5, 10000, null]]);
  const event = makeGatewayEvent({ id: walletId });
  const result = await fn(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.WALLET_NOT_READY);
};

test('GET /addresses', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [['my-wallet', 'xpubkey', 'ready', 5, 10000, 10001]]);
  await addToAddressTable(mysql, [['addr1', 0, 'my-wallet', 0], ['addr2', 1, 'my-wallet', 0]]);

  // missing param
  await _testMissingParam(addressesGet, 'id');

  // missing wallet
  await _testMissingWallet(addressesGet, 'some-wallet');

  // wallet not ready
  await _testWalletNotReady(addressesGet);

  // success case
  const event = makeGatewayEvent({ id: 'my-wallet' });
  const result = await addressesGet(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.addresses).toHaveLength(2);
  expect(returnBody.addresses).toContainEqual({ address: 'addr1', index: 0, transactions: 0 });
  expect(returnBody.addresses).toContainEqual({ address: 'addr2', index: 1, transactions: 0 });
});

test('GET /balances', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [['my-wallet', 'xpubkey', 'ready', 5, 10000, 10001]]);

  // missing param
  await _testMissingParam(balancesGet, 'id');

  // missing wallet
  await _testMissingWallet(balancesGet, 'some-wallet');

  // wallet not ready
  await _testWalletNotReady(balancesGet);

  // success but no balances
  let event = makeGatewayEvent({ id: 'my-wallet' });
  let result = await balancesGet(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.balances).toHaveLength(0);

  // add 2 balances
  await addToWalletBalanceTable(mysql, [['my-wallet', 'token1', 10, 0, 3]]);
  await addToWalletBalanceTable(mysql, [['my-wallet', 'token2', 3, 2, 1]]);

  // get all balances
  event = makeGatewayEvent({ id: 'my-wallet' });
  result = await balancesGet(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.balances).toHaveLength(2);
  expect(returnBody.balances).toContainEqual({ tokenId: 'token1', transactions: 3, balance: { unlocked: 10, locked: 0 } });
  expect(returnBody.balances).toContainEqual({ tokenId: 'token2', transactions: 1, balance: { unlocked: 3, locked: 2 } });

  // get token1 balance
  event = makeGatewayEvent({ id: 'my-wallet', token_id: 'token1' });
  result = await balancesGet(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.balances).toHaveLength(1);
  expect(returnBody.balances).toContainEqual({ tokenId: 'token1', transactions: 3, balance: { unlocked: 10, locked: 0 } });
});

test('GET /txhistory', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [['my-wallet', 'xpubkey', 'ready', 5, 10000, 10001]]);
  await addToWalletTxHistoryTable(mysql, [['my-wallet', 'tx1', '00', 5, 1000], ['my-wallet', 'tx1', 'token2', '7', 1000], ['my-wallet', 'tx2', '00', 7, 1001]]);

  // missing param
  await _testMissingParam(txHistoryGet, 'id');

  // missing wallet
  await _testMissingWallet(txHistoryGet, 'some-wallet');

  // wallet not ready
  await _testWalletNotReady(txHistoryGet);

  // invalid 'skip' param
  await _testInvalidParam(txHistoryGet, 'skip', { id: 'my-wallet', skip: 'aaa' });

  // invalid 'count' param
  await _testInvalidParam(txHistoryGet, 'count', { id: 'my-wallet', count: 'aaa' });

  // without token in parameters, use htr
  let event = makeGatewayEvent({ id: 'my-wallet' });
  let result = await txHistoryGet(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.history).toHaveLength(2);
  expect(returnBody.history).toContainEqual({ txId: 'tx1', timestamp: 1000, balance: 5 });
  expect(returnBody.history).toContainEqual({ txId: 'tx2', timestamp: 1001, balance: 7 });

  // with count just 1, return only the most recent tx
  event = makeGatewayEvent({ id: 'my-wallet', count: '1' });
  result = await txHistoryGet(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.count).toBe(1);
  expect(returnBody.history).toHaveLength(1);
  expect(returnBody.history).toContainEqual({ txId: 'tx2', timestamp: 1001, balance: 7 });

  // skip first item
  event = makeGatewayEvent({ id: 'my-wallet', skip: '1' });
  result = await txHistoryGet(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.skip).toBe(1);
  expect(returnBody.history).toHaveLength(1);
  expect(returnBody.history).toContainEqual({ txId: 'tx1', timestamp: 1000, balance: 5 });

  // use other token id
  event = makeGatewayEvent({ id: 'my-wallet', token_id: 'token2' });
  result = await txHistoryGet(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.history).toHaveLength(1);
  expect(returnBody.history).toContainEqual({ txId: 'tx1', timestamp: 1000, balance: 7 });
});

test('GET /wallet', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [['my-wallet', 'xpubkey', 'ready', 5, 10000, 10001]]);

  // missing param
  await _testMissingParam(walletGet, 'id');

  // missing wallet
  await _testMissingWallet(walletGet, 'some-wallet');

  // get all balances
  const event = makeGatewayEvent({ id: 'my-wallet' });
  const result = await walletGet(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.status).toStrictEqual({ walletId: 'my-wallet', xpubkey: 'xpubkey', status: 'ready', maxGap: 5, createdAt: 10000, readyAt: 10001 });
});

test('POST /wallet', async () => {
  expect.hasAssertions();

  // invalid body
  let event = makeGatewayEvent({});
  let result = await walletCreate(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.INVALID_BODY);

  event = makeGatewayEvent({}, 'aaa');
  result = await walletCreate(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.INVALID_BODY);

  // missing xpubkey
  event = makeGatewayEvent({}, JSON.stringify({ param1: 'aaa' }));
  result = await walletCreate(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.MISSING_PARAMETER);
  expect(returnBody.parameter).toBe('xpubkey');

  // invalid xpubkey
  event = makeGatewayEvent({}, JSON.stringify({ xpubkey: 'aaa' }));
  result = await walletCreate(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.INVALID_PARAMETER);
  expect(returnBody.parameter).toBe('xpubkey');

  // already loaded
  const walletId = getWalletId(XPUBKEY);
  await addToWalletTable(mysql, [[walletId, XPUBKEY, 'ready', 5, 10000, 10001]]);
  event = makeGatewayEvent({}, JSON.stringify({ xpubkey: XPUBKEY }));
  result = await walletCreate(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);
  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.WALLET_ALREADY_CREATED);
});
