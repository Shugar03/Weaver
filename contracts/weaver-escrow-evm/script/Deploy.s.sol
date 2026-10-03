// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {WeaverEscrow} from "../src/WeaverEscrow.sol";
import {WeaverCredits} from "../src/WeaverCredits.sol";

/// Deploy: forge script script/Deploy.s.sol --broadcast --account monad-operator
/// Requiere ETH_RPC_URL=https://testnet-rpc.monad.xyz
contract Deploy is Script {
    // USDC oficial de Circle en Monad testnet (6 dec)
    address constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    function run() external {
        address token = vm.envOr("ESCROW_TOKEN", USDC);
        vm.startBroadcast();
        WeaverEscrow escrow = new WeaverEscrow(token);
        WeaverCredits credits = new WeaverCredits(token);
        vm.stopBroadcast();
        console2.log("token", token);
        console2.log("WeaverEscrow", address(escrow));
        console2.log("WeaverCredits", address(credits));
        console2.log("admin", escrow.admin());
    }
}
