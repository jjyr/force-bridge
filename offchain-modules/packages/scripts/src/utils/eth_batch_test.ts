import fs from 'fs';
import { encodeToAddress, objectToTransactionSkeleton, parseAddress } from '@ckb-lumos/helpers';
import { IndexerCollector } from '@force-bridge/x/dist/ckb/tx-helper/collector';
import { txSkeletonToRawTransactionToSign } from '@force-bridge/x/dist/ckb/tx-helper/generator';
import { CkbIndexer } from '@force-bridge/x/dist/ckb/tx-helper/indexer';
import { CkbDeps } from '@force-bridge/x/dist/config';
import { asserts } from '@force-bridge/x/dist/errors';
import { asyncSleep } from '@force-bridge/x/dist/utils';
import { logger } from '@force-bridge/x/dist/utils/logger';
import ForceBridge from '@force-bridge/x/src/xchain/eth/abi/ForceBridge.json';
import { Script } from '@lay2/pw-core';
import CKB from '@nervosnetwork/ckb-sdk-core';
import { AddressPrefix, hexToBytes, bytesToHex } from '@nervosnetwork/ckb-sdk-utils';
import { ethers } from 'ethers';
import { JSONRPCClient } from 'json-rpc-2.0';
import fetch from 'node-fetch/index';
import { mkdir } from 'shelljs';
import { issueDevSUDT } from './deploySUDT';
import { pathFromProjectRoot, waitUntilCommitted } from '.';

export async function generateLockTx(
  client: JSONRPCClient,
  ethWallet: ethers.Wallet,
  assetIdent: string,
  nonce: number,
  recipient: string,
  amount: string,
  ethNodeURL: string,
): Promise<string> {
  const lockPayload = {
    sender: ethWallet.address,
    recipient: recipient,
    asset: {
      network: 'Ethereum',
      ident: assetIdent,
      amount: amount,
    },
  };
  const unsignedLockTx = await client.request('generateBridgeInNervosTransaction', lockPayload);
  logger.info('unsignedLockTx', unsignedLockTx);

  const provider = new ethers.providers.JsonRpcProvider(ethNodeURL);

  const unsignedTx = unsignedLockTx.rawTransaction;
  unsignedTx.value = unsignedTx.value ? ethers.BigNumber.from(unsignedTx.value.hex) : ethers.BigNumber.from(0);
  unsignedTx.nonce = nonce;
  unsignedTx.gasLimit = ethers.BigNumber.from(1000000);
  unsignedTx.gasPrice = await provider.getGasPrice();

  logger.info('unsignedTx', unsignedTx);

  const signedTx = await ethWallet.signTransaction(unsignedTx);
  logger.info('signedTx', signedTx);

  const hexTx = await Promise.resolve(signedTx).then((t) => ethers.utils.hexlify(t));
  return hexTx;
}

export async function generateBurnTx(
  ckb: CKB,
  client: JSONRPCClient,
  asset: string,
  ckbPriv: string,
  sender: string,
  recipient: string,
  amount: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const burnPayload = {
    network: 'Ethereum',
    sender: sender,
    recipient: recipient,
    asset: asset,
    amount: amount,
  };

  for (let i = 0; i < 5; i++) {
    try {
      const burnTxSkeleton = await client.request('generateBridgeOutNervosTransaction', burnPayload);
      const unsignedBurnTx = txSkeletonToRawTransactionToSign(
        objectToTransactionSkeleton(burnTxSkeleton.rawTransaction),
      );
      logger.info('unsignedBurnTx ', unsignedBurnTx);

      const signedTx = ckb.signTransaction(ckbPriv)(unsignedBurnTx);
      logger.info('signedTx', signedTx);
      return signedTx;
    } catch (e) {
      if (i == 4) {
        throw e;
      }
      logger.error('generateBridgeOutNervosTransaction error', e);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTransaction(client: JSONRPCClient, assetIdent: string, userIdent: string): Promise<any> {
  const getTxPayload = {
    network: 'Ethereum',
    xchainAssetIdent: assetIdent,
    user: {
      network: 'Nervos',
      ident: encodeToAddress(parseAddress(userIdent)),
    },
  };

  const txs = await client.request('getBridgeTransactionSummaries', getTxPayload);

  return txs;
}

async function checkTx(client: JSONRPCClient, assetIdent: string, txId: string, userIdent: string) {
  let find = false;
  let pending = false;
  for (let i = 0; i < 600; i++) {
    const txs = await getTransaction(client, assetIdent, userIdent);
    for (const tx of txs) {
      if (tx.txSummary.fromTransaction.txId == txId) {
        logger.info('tx', tx);
      }
      if (tx.status == 'Successful' && tx.txSummary.fromTransaction.txId == txId) {
        find = true;
        pending = false;
        break;
      }
      if (tx.status == 'Failed' && tx.txSummary.fromTransaction.txId == txId) {
        throw new Error(`rpc test failed, ${txId} occurs error ${tx.message}`);
      }
      if (tx.status == 'Pending' && tx.txSummary.fromTransaction.txId == txId) {
        pending = true;
      }
    }
    if (find) {
      break;
    }
    await asyncSleep(3000);
  }
  if (pending) {
    throw new Error(`rpc test failed, pending for 3000s ${txId}`);
  }
  if (!find) {
    throw new Error(`rpc test failed, can not find record ${txId}`);
  }
}

export async function lock(
  client: JSONRPCClient,
  provider: ethers.providers.JsonRpcProvider,
  ethWallet: ethers.Wallet,
  recipients: Array<string>,
  ethTokenAddress: string,
  lockAmount: string,
  ethNodeURL: string,
  intervalMs = 0,
): Promise<Array<string>> {
  const batchNum = recipients.length;
  const signedLockTxs = new Array<string>();
  const lockTxHashes = new Array<string>();
  const startNonce = await ethWallet.getTransactionCount();

  for (let i = 0; i < batchNum; i++) {
    const signedLockTx = await generateLockTx(
      client,
      ethWallet,
      ethTokenAddress,
      startNonce + i,
      recipients[i],
      lockAmount,
      ethNodeURL,
    );
    signedLockTxs.push(signedLockTx);
  }

  for (let i = 0; i < batchNum; i++) {
    const res = await provider.sendTransaction(signedLockTxs[i]);
    const lockTxHash = res.hash;
    logger.info(`send lock tx ${lockTxHash}`);
    const receipt = await res.wait();
    if (receipt.status != 0x0) {
      logger.info(`wait lock tx ${lockTxHash} success`);
    } else {
      logger.error(`wait lock tx ${lockTxHash} failed`);
      throw new Error(`wait lock tx ${lockTxHash} failed status ${receipt.status}`);
    }
    await asyncSleep(intervalMs);
    lockTxHashes.push(lockTxHash);
  }
  logger.info('lock txs', lockTxHashes);
  return lockTxHashes;
}

export async function dump_mock_tx(ckb: CKB, name: string, tx: any): Promise<void> {
  logger.info(`dump ${name} tx ${JSON.stringify(tx)}`);
  const mock_info: { inputs: any[]; cell_deps: any[]; header_deps: any[] } = {
    inputs: [],
    cell_deps: [],
    header_deps: [],
  };
  for (const input of tx['inputs']) {
    const inputTxWithStatus = await ckb.rpc.getTransaction(input['previousOutput']['txHash']);
    const blockHash = inputTxWithStatus.txStatus.blockHash;
    const { cell, status: _status } = await ckb.rpc.getLiveCell(input['previousOutput'], true);
    const mock_input = {
      input: {
        since: input['since'] ?? '0x0',
        previous_output: {
          index: input['previousOutput']['index'],
          tx_hash: input['previousOutput']['txHash'],
        },
      },
      output: {
        capacity: cell.output.capacity,
        lock: {
          code_hash: cell.output.lock.codeHash,
          hash_type: cell.output.lock.hashType,
          args: cell.output.lock.args,
        },
        type: cell.output.type
          ? {
              code_hash: cell.output.type?.codeHash,
              hash_type: cell.output.type?.hashType,
              args: cell.output.type?.args,
            }
          : null,
      },
      data: cell.data?.content ?? '0x',
      header: blockHash,
    };
    mock_info['inputs'].push(mock_input);
  }
  const deps: any[] = [];

  // parse dep group
  for (const dep of tx['cellDeps']) {
    if (dep['depType'] == 'depGroup') {
      const { cell, status: _status } = await ckb.rpc.getLiveCell(dep['outPoint'], true);
      const data = cell.data?.content ?? '0x';
      const rawData = hexToBytes(data);
      const outPointsCount = ((): number => {
        const buffer = rawData.slice(0, 4);
        return new DataView(buffer.buffer).getUint32(0, true /* littleEndian */);
      })();
      logger.info(`outPointsCount ${outPointsCount}`);
      for (let i = 0; i < outPointsCount; i++) {
        const rawOutPoint = rawData.slice(4 + i * 36, 4 + (i + 1) * 36);
        const dep = {
          out_point: {
            tx_hash: bytesToHex(rawOutPoint.slice(0, 32)),
            index: '0x' + new DataView(rawOutPoint.slice(32, 36).buffer).getUint32(0, true).toString(16),
          },
          dep_type: 'code',
        };
        logger.info(`parsed group dep ${JSON.stringify(dep)}`);
        deps.push(dep);
      }
    }
    const depCell = {
      out_point: {
        tx_hash: dep['outPoint']['txHash'],
        index: dep['outPoint']['index'],
      },
      dep_type: dep['depType'] == 'code' ? 'code' : 'dep_group',
    };
    deps.push(depCell);
  }

  for (const cellDep of deps) {
    const { cell, status: _status } = await ckb.rpc.getLiveCell(
      {
        txHash: cellDep.out_point.tx_hash,
        index: cellDep.out_point.index,
      },
      true,
    );
    const txWithStatus = ckb.rpc.getTransaction(cellDep.out_point.tx_hash);
    const mock_cellDep = {
      cell_dep: cellDep,
      output: {
        capacity: cell.output.capacity,
        lock: {
          code_hash: cell.output.lock.codeHash,
          hash_type: cell.output.lock.hashType,
          args: cell.output.lock.args,
        },
        type: cell.output.type
          ? {
              code_hash: cell.output.type?.codeHash,
              hash_type: cell.output.type?.hashType,
              args: cell.output.type?.args,
            }
          : null,
      },
      data: cell.data?.content ?? '0x',
      header: (await txWithStatus).txStatus.blockHash,
    };
    mock_info['cell_deps'].push(mock_cellDep);
  }

  const mock = {
    mock_info,
    tx: {
      version: tx['version'],
      cell_deps: tx['cellDeps'].map((cellDep) => {
        return {
          out_point: {
            index: cellDep['outPoint']['index'],
            tx_hash: cellDep['outPoint']['txHash'],
          },
          dep_type: cellDep['depType'] == 'code' ? 'code' : 'dep_group',
        };
      }),
      header_deps: tx['headerDeps'],
      inputs: tx['inputs'].map((input) => {
        return {
          previous_output: {
            index: input['previousOutput']['index'],
            tx_hash: input['previousOutput']['txHash'],
          },
          since: input['since'] ?? '0x0',
        };
      }),
      outputs: tx['outputs'].map((output) => {
        return {
          capacity: output['capacity'],
          lock: {
            code_hash: output['lock']['codeHash'],
            hash_type: output['lock']['hashType'],
            args: output['lock']['args'],
          },
          type: output['type']
            ? {
                code_hash: output['type']['codeHash'],
                hash_type: output['type']['hashType'],
                args: output['type']['args'],
              }
            : null,
        };
      }),
      outputs_data: tx['outputsData'],
      witnesses: tx['witnesses'],
    },
  };
  // write mock into file
  const mock_folder = pathFromProjectRoot('/debug-txs/');
  mkdir('-p', mock_folder);
  const mock_file = pathFromProjectRoot(`/debug-txs/${name}.json`);
  fs.writeFileSync(mock_file, JSON.stringify(mock, null, 2));
  logger.info(`dump ${name} tx done, path ${mock_file}`);
}

export async function burn(
  ckb: CKB,
  client: JSONRPCClient,
  ckbPrivs: Array<string>,
  senders: Array<string>,
  recipient: string,
  ethTokenAddress: string,
  burnAmount: string,
  intervalMs = 0,
): Promise<Array<string>> {
  const batchNum = ckbPrivs.length;
  const burnTxHashes = new Array<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signedBurnTxs = new Array<any>();
  for (let i = 0; i < batchNum; i++) {
    const burnTx = await generateBurnTx(ckb, client, ethTokenAddress, ckbPrivs[i], senders[i], recipient, burnAmount);
    signedBurnTxs.push(burnTx);
  }

  for (let i = 0; i < batchNum; i++) {
    await dump_mock_tx(ckb, `burn-tx-${i}.json`, signedBurnTxs[i]);
    const burnETHTxHash = await ckb.rpc.sendTransaction(signedBurnTxs[i], 'passthrough');
    await asyncSleep(intervalMs);
    burnTxHashes.push(burnETHTxHash);
  }
  logger.info('burn txs', burnTxHashes);
  return burnTxHashes;
}

export async function check(
  client: JSONRPCClient,
  txHashes: Array<string>,
  addresses: Array<string>,
  batchNum: number,
  ethTokenAddress: string,
): Promise<void> {
  for (let i = 0; i < batchNum; i++) {
    await checkTx(client, ethTokenAddress, txHashes[i], addresses[i]);
  }
}

export function prepareCkbPrivateKeys(batchNum: number): Array<string> {
  const privateKeys = new Array<string>();
  for (let i = 0; i < batchNum; i++) {
    privateKeys.push(ethers.Wallet.createRandom().privateKey);
  }
  return privateKeys;
}

export async function prepareCkbAddresses(
  ckb: CKB,
  privateKeys: Array<string>,
  ckbPrivateKey: string,
  ckbNodeUrl: string,
  ckbIndexerUrl: string,
  initCKB = 600,
): Promise<Array<string>> {
  const batchNum = ckbPrivateKey.length;
  const { secp256k1Dep } = await ckb.loadDeps();
  asserts(secp256k1Dep);
  const cellDeps = [
    {
      outPoint: secp256k1Dep.outPoint,
      depType: secp256k1Dep.depType,
    },
  ];

  const publicKey = ckb.utils.privateKeyToPublicKey(ckbPrivateKey);
  const args = `0x${ckb.utils.blake160(publicKey, 'hex')}`;
  const fromLockscript = {
    code_hash: secp256k1Dep.codeHash,
    args,
    hash_type: secp256k1Dep.hashType,
  };
  asserts(fromLockscript);
  const needSupplyCap = batchNum * initCKB * 100000000 + 100000;
  const collector = new IndexerCollector(new CkbIndexer(ckbNodeUrl, ckbIndexerUrl));

  const needSupplyCapCells = await collector.getCellsByLockscriptAndCapacity(fromLockscript, BigInt(needSupplyCap));
  const inputs = needSupplyCapCells.map((cell) => {
    return { previousOutput: { txHash: cell.out_point!.tx_hash, index: cell.out_point!.index }, since: '0x0' };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputs = new Array<any>();
  const outputsData = new Array<string>();
  const addresses = new Array<string>();
  for (const key of privateKeys) {
    const toPublicKey = ckb.utils.privateKeyToPublicKey(key);
    addresses.push(ckb.utils.pubkeyToAddress(toPublicKey, { prefix: AddressPrefix.Testnet }));

    const toArgs = `0x${ckb.utils.blake160(toPublicKey, 'hex')}`;
    const toScript = Script.fromRPC({
      code_hash: secp256k1Dep.codeHash,
      args: toArgs,
      hash_type: secp256k1Dep.hashType,
    });
    const capacity = initCKB * 100000000;
    const toScriptCell = {
      lock: toScript,
      capacity: `0x${capacity.toString(16)}`,
    };
    outputs.push(toScriptCell);
    outputsData.push('0x');
  }

  const inputCap = needSupplyCapCells.map((cell) => BigInt(cell.cell_output.capacity)).reduce((a, b) => a + b, 0n);
  const outputCap = outputs.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
  const changeCellCapacity = inputCap - outputCap - 10000000n;
  outputs.push({
    lock: Script.fromRPC(fromLockscript),
    capacity: `0x${changeCellCapacity.toString(16)}`,
  });
  outputsData.push('0x');

  const rawTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    witnesses: [{ lock: '', inputType: '', outputType: '' }],
    outputsData,
  };

  logger.info(`rawTx: ${JSON.stringify(rawTx, null, 2)}`);
  const signedTx = ckb.signTransaction(ckbPrivateKey)(rawTx);
  logger.info('signedTx', signedTx);

  const burnTxHash = await ckb.rpc.sendTransaction(signedTx, 'passthrough');
  logger.info('tx', burnTxHash);
  await waitUntilCommitted(ckb, burnTxHash, 60 * 1000);
  return addresses;
}

// const batchNum = 100;
// const lockAmount = '2000000000000000';
// const burnAmount = '1000000000000000';
// const ethTokenAddress = '0x0000000000000000000000000000000000000000';
//
// const forceBridgeUrl = process.env.FORCE_BRIDGE_RPC_URL || 'http://127.0.0.1:8080/force-bridge/api/v1';
//
// const ethNodeURL = process.env.ETH_URL || 'http://127.0.0.1:8545';
// const ethPrivatekey = process.env.ethPrivatekeyV_KEY || '0xc4ad657963930fbff2e9de3404b30a4e21432c89952ed430b56bf802945ed37a';
//
// const ckbNodeUrl = process.env.CKB_URL || 'http://127.0.0.1:8114';
// const ckbIndexerUrl = process.env.ckbIndexerUrl || 'http://127.0.0.1:8116';
// const ckbPrivateKey = process.env.ckbPrivateKeyV_KEY || '0xa800c82df5461756ae99b5c6677d019c98cc98c7786b80d7b2e77256e46ea1fe';

// const forceBridgeUrl = 'XXX';

// const ethNodeURL = 'XXX';
// const ethPrivatekey = 'XXX';

// const ckbNodeUrl = 'https://testnet.ckbapp.dev';
// const ckbIndexerUrl = 'https://testnet.ckbapp.dev/indexer';
// const ckbPrivateKey = 'XXX';

export async function ethBatchTest(
  ethPrivateKey: string,
  ckbPrivateKey: string,
  ethNodeUrl: string,
  ckbNodeUrl: string,
  ckbIndexerUrl: string,
  forceBridgeUrl: string,
  batchNum = 100,
  ethTokenAddress = '0x0000000000000000000000000000000000000000',
  lockAmount = '2000000000000000',
  burnAmount = '1000000000000000',
  fromEthSide = true,
  sudtOwnerPrivkey = '0x',
  ckbDeps?: CkbDeps,
): Promise<void> {
  logger.info('ethBatchTest start!');
  const ckb = new CKB(ckbNodeUrl);

  const client = new JSONRPCClient((jsonRPCRequest) =>
    fetch(forceBridgeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(jsonRPCRequest),
      id: 1,
    }).then((response) => {
      if (response.status === 200) {
        // Use client.receive when you received a JSON-RPC response.
        return response.json().then((jsonRPCResponse) => client.receive(jsonRPCResponse));
      } else if (jsonRPCRequest.id !== undefined) {
        return Promise.reject(new Error(response.statusText));
      }
    }),
  );

  const provider = new ethers.providers.JsonRpcProvider(ethNodeUrl);
  const ethWallet = new ethers.Wallet(ethPrivateKey, provider);
  const ethAddress = ethWallet.address;

  const ckbPrivs = await prepareCkbPrivateKeys(batchNum);
  const ckbAddresses = await prepareCkbAddresses(ckb, ckbPrivs, ckbPrivateKey, ckbNodeUrl, ckbIndexerUrl);

  if (fromEthSide) {
    logger.info('from eth side');
    const lockTxs = await lock(client, provider, ethWallet, ckbAddresses, ethTokenAddress, lockAmount, ethNodeUrl);
    await check(client, lockTxs, ckbAddresses, batchNum, ethTokenAddress);

    const burnTxs = await burn(ckb, client, ckbPrivs, ckbAddresses, ethAddress, ethTokenAddress, burnAmount);
    await check(client, burnTxs, ckbAddresses, batchNum, ethTokenAddress);
  } else {
    logger.info('from ckb side');
    // issue sudt
    logger.info('issue sudt');
    await issueDevSUDT(ckbNodeUrl, sudtOwnerPrivkey, ckbPrivateKey, ckbIndexerUrl, ckbDeps!, ckbAddresses);
    logger.info('done issue sudt');
    logger.info('move sudt from ckb to eth');
    const burnTxs = await burn(ckb, client, ckbPrivs, ckbAddresses, ethAddress, ethTokenAddress, burnAmount);
    logger.info('check - move sudt from ckb to eth');
    await check(client, burnTxs, ckbAddresses, batchNum, ethTokenAddress);

    logger.info('move sudt from eth to ckb');
    // Hack use smaller lockAmount to avoid error.
    lockAmount = '200000000000000';
    const lockTxs = await lock(client, provider, ethWallet, ckbAddresses, ethTokenAddress, lockAmount, ethNodeUrl);
    logger.info('check - move sudt from eth to ckb');
    await check(client, lockTxs, ckbAddresses, batchNum, ethTokenAddress);
  }
  logger.info('ethBatchTest pass!');
}

export async function initBridge(
  ethNodeUrl: string,
  ethPrivateKey: string,
  sudtId: string,
  forceBridgeAddress: string,
): Promise<string> {
  const provider = new ethers.providers.JsonRpcProvider(ethNodeUrl);
  const ethWallet = new ethers.Wallet(ethPrivateKey, provider);
  const contract = new ethers.Contract(forceBridgeAddress, ForceBridge.abi, ethWallet);
  const data = ethers.utils.defaultAbiCoder.encode(['string', 'string', 'uint8'], ['USDT', 'USDT', 18]);
  const nonce = await ethWallet.getTransactionCount();
  // append nonce to sudtId to avoid confliction during test
  sudtId += nonce.toString(16).padStart(2, '0');
  logger.info(`sudtId: ${sudtId} data: ${data}`);
  const tx = await contract.createGwERC20(sudtId, data);
  const receipt = await tx.wait();
  logger.info('initBridge receipt:', receipt);
  const event = receipt.events.find(
    (event) => event.address.toUpperCase() == forceBridgeAddress.toUpperCase() && event.event === 'CreateGwERC20',
  );
  const tokenAddress = '0x' + event.topics[1].slice(26);
  logger.info(`initBridge tx_hash: ${receipt.transactionHash} token: ${tokenAddress}`);
  return tokenAddress;
}
