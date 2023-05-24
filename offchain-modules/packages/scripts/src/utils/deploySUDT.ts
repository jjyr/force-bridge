import fs from 'fs';
import { OwnerCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { CkbDeps, WhiteListEthAsset } from '@force-bridge/x/dist/config';
import { logger } from '@force-bridge/x/dist/utils/logger';
import CKB from '@nervosnetwork/ckb-sdk-core';
import { cp, mkdir } from 'shelljs';
import { prepareCkbAddresses } from './eth_batch_test';
import { VerifierConfig } from './generate';
import { execShellCmd, pathFromProjectRoot, waitUntilCommitted } from './index';

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
  deployerPrivateKey: string,
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
  const sudtDeployInfoPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/deploy_sudt_info.json');
  //check file exists
  if (fs.existsSync(sudtDeployInfoPath)) {
    //read sudt
    const sudtDeployInfo = JSON.parse(fs.readFileSync(sudtDeployInfoPath, 'utf-8'));
    return sudtDeployInfo.sudtArgs;
  }

  // prepare address
  const ckb = new CKB(CKB_RPC_URL);
  const ckbAddresses = await prepareCkbAddresses(
    ckb,
    [deployerPrivateKey, ownerPrivateKey],
    ckbPrivateKey,
    CKB_RPC_URL,
    CKB_INDEXER_URL,
    100000,
  );
  const deployerAddress = ckbAddresses[0];
  const ownerAddress = ckbAddresses[1];
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
  const ckbCLiDeployGenTxs = `cd ${deployPath} && ${ckbCliDeploy} deploy gen-txs --deployment-config ${deployCfgPath} --migration-dir ${deployPath}/migrations --from-address ${deployerAddress} --info-file ${deployPath}/info.json`;
  // exec command gen txs
  await execShellCmd(ckbCLiDeployGenTxs);

  const signerPrivKeyPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/signer.privkey');
  // write deployer private key to file
  fs.writeFileSync(signerPrivKeyPath, deployerPrivateKey);
  const ownerPrivKeyPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/owner.privkey');
  // write deployer private key to file
  fs.writeFileSync(ownerPrivKeyPath, ownerPrivateKey);
  const ckbCLiDeploySignTxs = `cd ${deployPath} && ${ckbCliDeploy} deploy sign-txs --add-signatures --privkey-path ${signerPrivKeyPath} --info-file ${deployPath}/info.json`;
  await execShellCmd(ckbCLiDeploySignTxs);

  // Apply deployment transaction with ckb-cli
  // ckb-cli-deploy deploy apply-txs --migration-dir ./migrations --info-file ./info.json
  const ckbCLiDeployApplyTxs = `cd ${deployPath} && ${ckbCliDeploy} deploy apply-txs --migration-dir ${deployPath}/migrations --info-file ${deployPath}/info.json`;
  await execShellCmd(ckbCLiDeployApplyTxs);
  // read info.json
  const infoJsonPath = pathFromProjectRoot('/workdir/integration-erc20/simple-udt-deploy/info.json');
  const infoJson = JSON.parse(fs.readFileSync(infoJsonPath, 'utf-8'));
  const simple_udt = infoJson['new_recipe']['cell_recipes'].find((recipe) => recipe['name'] === 'simple_udt');
  const tx_hash = simple_udt['tx_hash'];
  const type_id = simple_udt['type_id'];

  // wait tx to be committed
  await waitUntilCommitted(ckb, tx_hash, 60 * 1000);

  // create cell_deps.json
  const cell_deps = {
    items: {
      sudt: {
        script_id: {
          hash_type: 'type',
          code_hash: type_id,
        },
        cell_dep: {
          out_point: {
            tx_hash: tx_hash,
            index: '0x0',
          },
          dep_type: 'code',
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
  // const sudtScript: CKBComponents.Script = {
  //   codeHash: type_id,
  //   hashType: 'type',
  //   args: sudtArgs,
  // };
  // const sudtScriptHash = ckb.utils.scriptToHash(script);

  logger.info('sudtArgs:', sudtArgs);

  // write sudtID to file
  fs.writeFileSync(sudtDeployInfoPath, JSON.stringify({ sudtArgs: sudtArgs }));
  return sudtArgs;
}
