import { BigNumber } from 'bignumber.js';
import { WhiteListEthAsset } from '../../config';
import { ForceBridgeCore } from '../../core';
import { fromHexString, stringToUint8Array, toHexString } from '../../utils';
import { SerializeForceBridgeLockscriptArgs } from '../tx-helper/generated/force_bridge_lockscript';
import { ScriptLike } from './script';

export enum ChainType {
  BTC,
  ETH,
  EOS,
  TRON,
  POLKADOT,
}

export abstract class Asset {
  public chainType: ChainType;
  public ownerCellTypeHash: string;

  protected constructor(ownerCellTypeHash?: string) {
    if (ownerCellTypeHash) {
      this.ownerCellTypeHash = ownerCellTypeHash;
      return;
    }

    this.ownerCellTypeHash = ForceBridgeCore.ckb.utils.scriptToHash(<CKBComponents.Script>{
      codeHash: ForceBridgeCore.config.ckb.ownerCellTypescript.code_hash,
      hashType: ForceBridgeCore.config.ckb.ownerCellTypescript.hash_type,
      args: ForceBridgeCore.config.ckb.ownerCellTypescript.args,
    });
  }

  public toTypeScript(): ScriptLike {
    const bridgeCellLockscript = {
      codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
      hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
      args: this.toBridgeLockscriptArgs(),
    };
    return new ScriptLike(
      ForceBridgeCore.config.ckb.deps.sudtType.script.codeHash,
      ForceBridgeCore.ckb.utils.scriptToHash(bridgeCellLockscript),
      ForceBridgeCore.config.ckb.deps.sudtType.script.hashType,
    );
  }

  public inWhiteList(): boolean {
    switch (this.chainType) {
      case ChainType.ETH: {
        const whiteAssetList = ForceBridgeCore.config.eth.assetWhiteList;
        if (whiteAssetList.length === 0) return true;
        return (
          undefined !== whiteAssetList.find((asset) => asset.address.toUpperCase() === this.getAddress().toUpperCase())
        );
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        return true;
    }
  }

  assetConfig(): WhiteListEthAsset | undefined {
    switch (this.chainType) {
      case ChainType.ETH: {
        const whiteAssetList = ForceBridgeCore.config.eth.assetWhiteList;
        const asset = whiteAssetList.find((asset) => asset.address.toUpperCase() === this.getAddress().toUpperCase());
        return asset;
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        return undefined;
    }
  }

  public getMinimalAmount(): string {
    switch (this.chainType) {
      case ChainType.ETH: {
        const asset = this.assetConfig();
        if (!asset) throw new Error('minimal amount not configed');
        return asset.minimalBridgeAmount;
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        return '0';
    }
  }
  public getBridgeFee(direction: 'in' | 'out'): string {
    switch (this.chainType) {
      case ChainType.ETH: {
        const currentAsset = this.assetConfig();
        if (!currentAsset) throw new Error('asset not in white list');
        if (direction === 'in') return currentAsset.bridgeFee.in;
        return currentAsset.bridgeFee.out;
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        return '0';
    }
  }
  public getHumanizedDescription(amount: string): string {
    switch (this.chainType) {
      case ChainType.ETH: {
        const asset = this.assetConfig();
        if (!asset) throw new Error('asset not in white list');
        const humanizedAmount = new BigNumber(amount).times(new BigNumber(10).pow(-asset.decimal)).toString();
        return `${humanizedAmount} ${asset.symbol}`;
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        throw new Error('unimplement');
    }
  }
  public parseAmount(amount: string): string {
    switch (this.chainType) {
      case ChainType.ETH: {
        const asset = this.assetConfig();
        if (!asset) throw new Error('asset not in white list');
        return new BigNumber(amount).times(new BigNumber(10).pow(asset.decimal)).toString();
      }
      case ChainType.BTC:
      case ChainType.EOS:
      case ChainType.TRON:
      case ChainType.POLKADOT:
        throw new Error('unimplement');
    }
  }
  public abstract toBridgeLockscriptArgs(): string;
  public abstract getAddress(): string;
  public abstract getSUDTArgs(): string;
}

export function getAsset(chain: number, asset: string): Asset {
  switch (chain) {
    case ChainType.ETH: {
      return new EthAsset(asset);
    }
    default:
      throw new Error(`chainType ${ChainType} not supported yet`);
  }
}

export class EthAsset extends Asset {
  public sudtArgs: string | undefined;
  // '0x00000000000000000000' represents ETH
  // other address represents ERC20 address
  constructor(public address: string, ownerCellTypeHash = '') {
    super(ownerCellTypeHash);
    this.chainType = ChainType.ETH;
    const asset = this.assetConfig();
    if ((!asset && !address.startsWith('0x')) || address.length !== 42) {
      throw new Error('invalid ETH asset address');
    }
    this.sudtArgs = asset?.sudtArgs;
    if (this.sudtArgs && (!this.sudtArgs.startsWith('0x') || this.sudtArgs.length !== 66)) {
      throw new Error(`invalid SUDT script args ${this.sudtArgs}`);
    }
    if (address !== '0x0000000000000000000000000000000000000000' && !this.sudtArgs) {
      throw new Error(`invalid SUDT script args, address ${address} sUDT ${this.sudtArgs}`);
    }
  }

  toBridgeLockscriptArgs(): string {
    const params = {
      owner_cell_type_hash: fromHexString(this.ownerCellTypeHash).buffer,
      chain: this.chainType,
      asset: fromHexString(toHexString(stringToUint8Array(this.address))).buffer,
    };
    return `0x${toHexString(new Uint8Array(SerializeForceBridgeLockscriptArgs(params)))}`;
  }

  getAddress(): string {
    return this.address;
  }

  getSUDTArgs(): string {
    return this.sudtArgs ?? '0x';
  }
}

export class TronAsset extends Asset {
  constructor(public address: string, public ownerCellTypeHash: string = '') {
    super();
    this.chainType = ChainType.TRON;
  }

  toBridgeLockscriptArgs(): string {
    const params = {
      owner_cell_type_hash: fromHexString(this.ownerCellTypeHash).buffer,
      chain: this.chainType,
      asset: fromHexString(toHexString(stringToUint8Array(this.address))).buffer,
    };
    return `0x${toHexString(new Uint8Array(SerializeForceBridgeLockscriptArgs(params)))}`;
  }

  getAddress(): string {
    return this.address;
  }

  getSUDTArgs(): string {
    return '0x';
  }
}

export class EosAsset extends Asset {
  constructor(public address: string, public ownerCellTypeHash: string = '') {
    super();
    this.chainType = ChainType.EOS;
  }

  toBridgeLockscriptArgs(): string {
    const params = {
      owner_cell_type_hash: fromHexString(this.ownerCellTypeHash).buffer,
      chain: this.chainType,
      asset: fromHexString(toHexString(stringToUint8Array(this.address))).buffer,
    };
    return `0x${toHexString(new Uint8Array(SerializeForceBridgeLockscriptArgs(params)))}`;
  }

  getAddress(): string {
    return this.address;
  }

  getSUDTArgs(): string {
    return '0x';
  }
}

export class BtcAsset extends Asset {
  constructor(public address: string, public ownerCellTypeHash: string = '') {
    super();
    this.chainType = ChainType.BTC;
  }

  toBridgeLockscriptArgs(): string {
    const params = {
      owner_cell_type_hash: fromHexString(this.ownerCellTypeHash).buffer,
      chain: this.chainType,
      asset: fromHexString(toHexString(stringToUint8Array(this.address))).buffer,
    };
    return `0x${toHexString(new Uint8Array(SerializeForceBridgeLockscriptArgs(params)))}`;
  }

  getAddress(): string {
    return this.address;
  }

  getSUDTArgs(): string {
    return '0x';
  }
}
