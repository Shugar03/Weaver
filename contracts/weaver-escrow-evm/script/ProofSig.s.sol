// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";

/// Genera el proof L0 para un job: firma personal-sign del signer del forge
/// sobre keccak256(resultHash ‖ jobId). Mismo formato que verifica
/// WeaverEscrow.release. Output para `cast send ... release`.
///   forge script script/ProofSig.s.sol -vvv
contract ProofSig is Script {
    // key throwaway del forge de demo (solo firma proofs, sin fondos)
    uint256 constant FORGE_SK = 0xd777e6cdff64decdcd304c06e1c2d0f29cdb03e695180f1bf5351a234bfffb9f;
    bytes32 constant RESULT_HASH = 0x6948cc5c41ac8d31762de5d69f40405e701adafb38c219d7c6b7cf77344e6561; // keccak("weaver-gen0-demo-result")
    uint256 constant JOB_ID = 1;

    function run() external view {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(RESULT_HASH, JOB_ID))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(FORGE_SK, digest);
        console2.log("resultHash:");
        console2.logBytes32(RESULT_HASH);
        console2.log("sig:");
        console2.logBytes(abi.encodePacked(r, s, v));
    }
}
