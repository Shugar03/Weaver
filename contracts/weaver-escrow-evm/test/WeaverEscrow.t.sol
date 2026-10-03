// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {WeaverEscrow} from "../src/WeaverEscrow.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Test USDC", "TUSDC") {}
    function decimals() public pure override returns (uint8) {
        return 6;
    }
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract WeaverEscrowTest is Test {
    uint256 constant UNIT = 1_000_000; // 1.0 USDC (6 dec)
    uint256 constant PAYOUT = 10_000; // $0.01
    bytes32 constant HASH = bytes32(uint256(7));

    MockUSDC token;
    WeaverEscrow escrow;
    address admin = address(this);
    address client = makeAddr("client");
    address workerA = makeAddr("workerA");
    address workerB = makeAddr("workerB");
    uint256 skA = uint256(0x42);
    uint256 skB = uint256(0x77);
    address signerA;
    address signerB;

    function setUp() public {
        signerA = vm.addr(skA);
        signerB = vm.addr(skB);
        token = new MockUSDC();
        escrow = new WeaverEscrow(address(token));
        token.mint(client, 1_000 * UNIT);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(workerA);
        escrow.registerForge(signerA);
    }

    /// digest que firma el forge: personal-sign de keccak256(resultHash ‖ jobId)
    function proof(uint256 sk, bytes32 resultHash, uint256 jobId) internal pure returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(resultHash, jobId))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sk, digest);
        return abi.encodePacked(r, s, v);
    }

    function fund(address worker) internal returns (uint256) {
        vm.prank(client);
        return escrow.fundJob(PAYOUT, worker);
    }

    function test_admin_es_deployer() public view {
        assertEq(escrow.admin(), admin);
        assertEq(escrow.version(), 1);
    }

    function test_fund_a_forge_no_registrado_falla_temprano() public {
        vm.prank(client);
        vm.expectRevert(WeaverEscrow.ForgeNotFound.selector);
        escrow.fundJob(PAYOUT, workerB);
    }

    function test_fund_mueve_tokens_y_deja_funded() public {
        uint256 before = token.balanceOf(client);
        uint256 id = fund(workerA);
        assertEq(id, 1);
        assertEq(token.balanceOf(client), before - PAYOUT);
        assertEq(token.balanceOf(address(escrow)), PAYOUT);
        WeaverEscrow.Job memory j = escrow.getJob(1);
        assertEq(j.client, client);
        assertEq(j.worker, workerA);
        assertTrue(j.state == WeaverEscrow.JobState.Funded);
    }

    function test_firma_de_otro_forge_no_paga() public {
        vm.prank(workerB);
        escrow.registerForge(signerB);
        fund(workerA);
        vm.expectRevert(WeaverEscrow.BadSignature.selector);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skB, HASH, 1));
        assertTrue(escrow.getJob(1).state == WeaverEscrow.JobState.Funded);
    }

    function test_dos_forges_cobran_cada_uno_lo_suyo() public {
        vm.prank(workerB);
        escrow.registerForge(signerB);
        fund(workerA);
        fund(workerB);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skA, HASH, 1));
        vm.prank(admin);
        escrow.release(2, HASH, proof(skB, HASH, 2));
        assertEq(token.balanceOf(workerA), PAYOUT);
        assertEq(token.balanceOf(workerB), PAYOUT);
    }

    function test_worker_self_claim_sin_admin() public {
        fund(workerA);
        vm.prank(workerA);
        escrow.release(1, HASH, proof(skA, HASH, 1));
        assertEq(token.balanceOf(workerA), PAYOUT);
        assertTrue(escrow.getJob(1).state == WeaverEscrow.JobState.Released);
        assertEq(escrow.getJob(1).resultHash, HASH);
    }

    function test_worker_no_puede_claimear_job_ajeno() public {
        fund(workerA);
        vm.expectRevert(WeaverEscrow.Unauthorized.selector);
        vm.prank(workerB);
        escrow.release(1, HASH, proof(skA, HASH, 1));
    }

    function test_register_forge_rota_la_clave() public {
        uint256 newSk = uint256(0x99);
        vm.prank(workerA);
        escrow.registerForge(vm.addr(newSk));
        fund(workerA);
        vm.prank(admin);
        escrow.release(1, HASH, proof(newSk, HASH, 1));
        assertTrue(escrow.getJob(1).state == WeaverEscrow.JobState.Released);
        // la clave vieja ya no verifica para jobs nuevos
        fund(workerA);
        vm.expectRevert(WeaverEscrow.BadSignature.selector);
        vm.prank(admin);
        escrow.release(2, HASH, proof(skA, HASH, 2));
    }

    function test_sig_sobre_otro_job_no_verifica() public {
        fund(workerA);
        // firma válida pero ligada al jobId 2 — el proof va ligado al job
        vm.expectRevert(WeaverEscrow.BadSignature.selector);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skA, HASH, 2));
    }

    function test_doble_release_falla() public {
        fund(workerA);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skA, HASH, 1));
        vm.expectRevert(WeaverEscrow.BadState.selector);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skA, HASH, 1));
    }

    function test_refund_dentro_de_ventana_falla() public {
        fund(workerA);
        vm.expectRevert(WeaverEscrow.TooEarly.selector);
        vm.prank(client);
        escrow.refund(1);
    }

    function test_refund_tras_ventana_devuelve_cliente() public {
        fund(workerA);
        vm.warp(block.timestamp + 86_401);
        vm.prank(client);
        escrow.refund(1);
        assertTrue(escrow.getJob(1).state == WeaverEscrow.JobState.Refunded);
    }

    function test_refund_no_es_del_cliente() public {
        fund(workerA);
        vm.warp(block.timestamp + 86_401);
        vm.expectRevert(WeaverEscrow.Unauthorized.selector);
        vm.prank(workerA);
        escrow.refund(1);
    }

    function test_job_inexistente_falla() public {
        vm.expectRevert(WeaverEscrow.JobNotFound.selector);
        escrow.getJob(99);
    }

    event Released(uint256 indexed jobId, address indexed worker, uint256 amount, bytes32 resultHash);

    function test_release_emite_hash_onchain() public {
        fund(workerA);
        vm.expectEmit(true, true, false, true);
        emit Released(1, workerA, PAYOUT, HASH);
        vm.prank(admin);
        escrow.release(1, HASH, proof(skA, HASH, 1));
    }
}
