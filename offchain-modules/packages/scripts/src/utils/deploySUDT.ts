import fs from 'fs';
import { OwnerCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { CkbDeps, WhiteListEthAsset } from '@force-bridge/x/dist/config';
import { logger } from '@force-bridge/x/dist/utils/logger';
import CKB from '@nervosnetwork/ckb-sdk-core';
import { cp, mkdir } from 'shelljs';
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

export async function deployDevSUDT(
  // ETH_RPC_URL: string,
  CKB_RPC_URL: string,
  ownerPrivateKey: string,
  ckbPrivateKey: string,
  CKB_INDEXER_URL: string,
  // MULTISIG_NUMBER: number,
  // MULTISIG_THRESHOLD: number,
  // ethPrivateKey: string,
  // env: 'LINA' | 'AGGRON4' | 'DEV' = 'DEV',
  // multiCellXchainType: string,
  // cachePath?: string,
  // ckbDeps?: CkbDeps,
): Promise<string> {
  // prepare address
  const ckb = new CKB(CKB_RPC_URL);
  const ckbAddresses = await prepareCkbAddresses(ckb, [ownerPrivateKey], ckbPrivateKey, CKB_RPC_URL, CKB_INDEXER_URL);
  const ownerAddress = ckbAddresses[0];
  const script = ckb.utils.addressToScript(ownerAddress);
  logger.info('ownerAddress script:', script);

  // create deploy path
  const originCfgPath = pathFromProjectRoot('/deploy-dev-configs/deployment.toml');
  const originSUDTPath = pathFromProjectRoot('/deploy-dev-configs/contracts/simple_udt');
  const deployPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy');
  const deployCfgPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/deployment.toml');
  mkdir('-p', deployPath + '/migrations');
  mkdir('-p', deployPath + '/contracts');
  cp(originCfgPath, deployPath);
  cp(originSUDTPath, deployPath + '/contracts');

  logger.info('Prepared deploy dir');

  // Generate deployment transaction with ckb-cli
  // Run shell command:
  // ckb-cli-deploy deploy gen-txs \
  //   --deployment-config ./deployment.toml \
  //   --migration-dir ./migrations \
  //   --from-address <your-account> \
  //   --info-file ./info.json \
  //   --sign-now
  // run shell in js
  const ckbCliDeploy = 'ckb-cli';
  const ckbCLiDeployGenTxs = `cd ${deployPath} && ${ckbCliDeploy} deploy gen-txs --deployment-config ${deployCfgPath} --migration-dir ${deployPath}/migrations --from-address ${ownerAddress} --info-file ${deployPath}/info.json`;
  // exec command gen txs
  await execShellCmd(ckbCLiDeployGenTxs);

  const signerPrivKeyPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/signer.privkey');
  // write owner private key to file
  fs.writeFileSync(signerPrivKeyPath, ownerPrivateKey);
  const ckbCLiDeploySignTxs = `cd ${deployPath} && ${ckbCliDeploy} deploy sign-txs --privkey-path ${signerPrivKeyPath} --info-file ${deployPath}/info.json`;
  await execShellCmd(ckbCLiDeploySignTxs);

  // Apply deployment transaction with ckb-cli
  // ckb-cli-deploy deploy apply-txs --migration-dir ./migrations --info-file ./info.json
  const ckbCLiDeployApplyTxs = `cd ${deployPath} ${ckbCliDeploy} deploy apply-txs --migration-dir ${deployPath}/migrations --info-file ${deployPath}/info.json`;
  await execShellCmd(ckbCLiDeployApplyTxs);

  // create cell_deps.json
  return 'Ok';
}
