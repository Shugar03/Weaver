// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {WeaverCredits} from "../src/WeaverCredits.sol";

contract MockUSDC2 is ERC20 {
    constructor() ERC20("Test USDC", "TUSDC") {}
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract WeaverCreditsTest is Test {
    MockUSDC2 token;
    WeaverCredits credits;
    address payer = makeAddr("payer");
    bytes32 constant ACCT = keccak256("acct_demo1");

    event Deposited(bytes32 indexed account, address indexed payer, uint256 amount);

    function setUp() public {
        token = new MockUSDC2();
        credits = new WeaverCredits(address(token));
        token.mint(payer, 1000e6);
        vm.prank(payer);
        token.approve(address(credits), type(uint256).max);
    }

    function test_deposit_emite_evento_y_mueve_tokens() public {
        vm.expectEmit(true, true, false, true);
        emit Deposited(ACCT, payer, 5e6);
        vm.prank(payer);
        credits.deposit(ACCT, 5e6);
        assertEq(token.balanceOf(address(credits)), 5e6);
    }

    function test_deposit_cero_falla() public {
        vm.expectRevert(WeaverCredits.BadAmount.selector);
        vm.prank(payer);
        credits.deposit(ACCT, 0);
    }

    function test_sweep_solo_admin() public {
        vm.prank(payer);
        credits.deposit(ACCT, 5e6);
        vm.prank(payer);
        vm.expectRevert("not admin");
        credits.sweep(5e6);
        credits.sweep(5e6);
        assertEq(token.balanceOf(address(this)), 5e6);
    }
}
