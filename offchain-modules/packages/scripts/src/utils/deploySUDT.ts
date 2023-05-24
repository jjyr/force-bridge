import fs from 'fs';
import { OwnerCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { CkbDeps, WhiteListEthAsset } from '@force-bridge/x/dist/config';
import { logger } from '@force-bridge/x/dist/utils/logger';
import CKB from '@nervosnetwork/ckb-sdk-core';
import { mkdir } from 'shelljs';
import { prepareCkbAddresses } from './eth_batch_test';
import { VerifierConfig } from './generate';
import { execShellCmd, pathFromProjectRoot } from './index';

export interface DeployDevResult {
  assetWhiteList: WhiteListEthAsset[];
  ckbDeps: CkbDeps;
  ownerConfig: OwnerCellConfig;
  bridgeEthAddress: string;
  multisigConfig: {
    threshold: number;
    verifiers: VerifierConfig[];
  };
  ckbStartHeight: number;
  ethStartHeight: number;
  ckbPrivateKey: string;
  ethPrivateKey: string;
}

export async function issueDevSUDT(
  CKB_RPC_URL: string,
  ownerPrivateKey: string,
  ckbPrivateKey: string,
  CKB_INDEXER_URL: string,
  ckbDeps: CkbDeps,
): Promise<CKBComponents.Script> {
  // prepare address
  const ckb = new CKB(CKB_RPC_URL);
  const ckbAddresses = await prepareCkbAddresses(
    ckb,
    [ownerPrivateKey],
    ckbPrivateKey,
    CKB_RPC_URL,
    CKB_INDEXER_URL,
    100000,
  );
  const ownerAddress = ckbAddresses[0];
  const script = ckb.utils.addressToScript(ownerAddress);
  logger.info('ownerAddress script:', script);

  // create deploy path
  const deployPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy');
  mkdir('-p', deployPath);

  const ownerPrivKeyPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/owner.privkey');
  fs.writeFileSync(ownerPrivKeyPath, ownerPrivateKey);

  // create cell_deps.json
  const cell_deps = {
    items: {
      sudt: {
        script_id: {
          hash_type: ckbDeps.sudtType.script.hashType,
          code_hash: ckbDeps.sudtType.script.codeHash,
        },
        cell_dep: {
          out_point: ckbDeps.sudtType.cellDep.outPoint,
          dep_type: ckbDeps.sudtType.cellDep.depType,
        },
      },
    },
  };
  // write cell_deps.json
  const cellDepsJsonPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/cell_deps.json');
  fs.writeFileSync(cellDepsJsonPath, JSON.stringify(cell_deps));
  // Run shell command
  // ckb-cli sudt issue \
  // --owner ckt1qyq86vaa6e8tsruv5ngcd5tp7lcvcewxy7cquuksvj \
  // --udt-to ckt1qyqfjslcvyaay029vvfxtn80rxnwmlma43xscrqn85:2000 \
  // --to-cheque-address \
  // --cell-deps ./cell_deps.json
  const amount = 100000000;
  const ckbCliSUDTCommand = `cd ${deployPath} && ckb-cli sudt issue --privkey-path ${ownerPrivKeyPath} --owner ${ownerAddress} --udt-to ${ownerAddress}:${amount} --cell-deps ${cellDepsJsonPath}`;
  await execShellCmd(ckbCliSUDTCommand);

  const sudtArgs = ckb.utils.scriptToHash(script);
  const sudtScript: CKBComponents.Script = {
    codeHash: ckbDeps.sudtType.script.codeHash,
    hashType: ckbDeps.sudtType.script.hashType,
    args: sudtArgs,
  };

  logger.info('sudtArgs:', sudtArgs);

  // write sudtID to file
  return sudtScript;
}
