use crate::adapter::Adapter;
use ckb_std::ckb_constants::Source;

#[cfg(not(feature = "std"))]
use alloc::string::String;

use blake2b_ref::{Blake2b, Blake2bBuilder};
use ckb_std::ckb_types::packed::{Byte32, Bytes, Script};
use force_bridge_types::{
    generated::basic, generated::force_bridge_lockscript::ForceBridgeLockscriptArgs,
    recipient_cell::RecipientDataView,
};
use molecule::prelude::{Builder, Byte, Entity};
use std::prelude::v1::*;

pub const CKB_HASH_PERSONALIZATION: &[u8] = b"ckb-default-hash";

pub fn verify_burn_token<T: Adapter>(data_loader: T, data: RecipientDataView) {
    if data.amount == 0 {
        panic!(
            "burn amount should be greater than 0, burned {:?}",
            data.amount
        )
    }
    let input_sudt_num =
        data_loader.get_sudt_amount_from_source(Source::Input, None);
    let output_sudt_num =
        data_loader.get_sudt_amount_from_source(Source::Output, None);
    if input_sudt_num < output_sudt_num {
        panic!(
            "input sudt less than output sudt, input {:?}, output {:?}",
            input_sudt_num, output_sudt_num
        )
    }
    if input_sudt_num - output_sudt_num != data.amount {
        panic!(
            "burned token amount not match data amount, input {:?}, output {:?}, data {:?}",
            input_sudt_num, output_sudt_num, data.amount
        )
    }
}

fn calc_xchain_bridge_lock_hash(
    owner_cell_type_hash: &[u8; 32],
    chain: u8,
    asset: String,
    for_bridge_lock_code_hash: &[u8; 32],
    for_bridge_lock_hash_type: u8,
) -> [u8; 32] {
    let args = ForceBridgeLockscriptArgs::new_builder()
        .owner_cell_type_hash(
            basic::Byte32::from_slice(owner_cell_type_hash)
                .expect("convert light_client_typescript_hash to Bytes32"),
        )
        .chain(chain.into())
        .asset(asset.into())
        .build();

    let bytes_vec = args.as_slice().iter().map(|b| Byte::new(*b)).collect();

    let force_bridge_lockscript = Script::new_builder()
        .code_hash(
            Byte32::from_slice(for_bridge_lock_code_hash)
                .expect("for_bridge_lock_code_hash invalid"),
        )
        .hash_type(Byte::new(for_bridge_lock_hash_type))
        .args(Bytes::new_builder().set(bytes_vec).build())
        .build();

    blake2b_256(force_bridge_lockscript.as_slice())
}

fn new_blake2b() -> Blake2b {
    Blake2bBuilder::new(32)
        .personal(CKB_HASH_PERSONALIZATION)
        .build()
}

fn blake2b_256(s: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut blake2b = new_blake2b();
    blake2b.update(s);
    blake2b.finalize(&mut result);
    result
}
