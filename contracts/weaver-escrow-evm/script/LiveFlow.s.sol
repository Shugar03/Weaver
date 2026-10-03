// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {WeaverEscrow} from "../src/WeaverEscrow.sol";

/// Live end-to-end contra testnet: el operador actúa como client+worker+admin.
/// Registra un signer de forge (key throwaway de demo), aprueba USDC y fondea
/// el job #1. El release va por `cast send` con la firma del forge.
///   forge script script/LiveFlow.s.sol --broadcast --account monad-operator -vvv
contract LiveFlow is Script {
    address constant ESCROW = 0x743C4299e79D7A1Bfe3e6491971eF6116988fc2C;
    address constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    /// operador (deployer del escrow; también client+worker del job demo)
    address constant OPERATOR = 0xbaD8908CD47c0A47F31F35a45e5c8Ba14878aF3B;
    /// signer de forge de demo (key throwaway, sin fondos — solo firma proofs)
    address constant FORGE_SIGNER = 0x7c41eb4274b7e5C51e44BA01606d9Db403BBbebc;
    uint256 constant PAYOUT = 10_000; // 0.01 USDC

    function run() external {
        WeaverEscrow escrow = WeaverEscrow(ESCROW);
        vm.startBroadcast();
        escrow.registerForge(FORGE_SIGNER);
        IERC20(USDC).approve(ESCROW, PAYOUT);
        uint256 jobId = escrow.fundJob(PAYOUT, OPERATOR);
        vm.stopBroadcast();
        console2.log("jobId", jobId);
        console2.log("worker", OPERATOR);
        console2.log("signer", FORGE_SIGNER);
    }
}
