// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title WeaverEscrow — liquidación por job en EVM (port del escrow Soroban, ADR-0008)
/// @notice fund (operator) → release contra proof L0 firmado por el forge →
///         o refund tras la ventana de claim. La firma se verifica contra el
///         signer que CADA worker registró — proof del forge A no paga el job
///         del forge B.
contract WeaverEscrow is ReentrancyGuard {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    uint64 public constant CLAIM_WINDOW = 86_400; // 24h: refund bloqueado (anti refund-rug)

    enum JobState {
        Funded,
        Released,
        Refunded
    }

    struct Job {
        address client;
        address worker;
        uint256 amount;
        JobState state;
        uint64 fundedAt;
        bytes32 resultHash;
    }

    address public immutable admin;
    IERC20 public immutable token;
    uint256 private _nextId = 1;

    /// worker (payout) → signer (address que firma los proofs; puede ser otra key)
    mapping(address => address) public forges;
    mapping(uint256 => Job) private _jobs;

    event ForgeRegistered(address indexed worker, address indexed signer);
    event Funded(uint256 indexed jobId, address indexed client, address indexed worker, uint256 amount);
    event Released(uint256 indexed jobId, address indexed worker, uint256 amount, bytes32 resultHash);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error Unauthorized();
    error JobNotFound();
    error BadState();
    error BadAmount();
    error ForgeNotFound();
    error TooEarly();
    error BadSignature();

    constructor(address token_) {
        admin = msg.sender;
        token = IERC20(token_);
    }

    function version() external pure returns (uint32) {
        return 1;
    }

    /// @notice El worker (msg.sender, payout) autoriza qué address firma sus
    ///         proofs — puede ser otra key (hot key firma, cold cobra).
    ///         Re-registrar rota la clave; es decisión del worker, no del admin.
    function registerForge(address signer) external {
        require(signer != address(0), "signer=0");
        forges[msg.sender] = signer;
        emit ForgeRegistered(msg.sender, signer);
    }

    /// @notice Fondea un job: mueve `amount` del cliente al contrato. El worker
    ///         va ligado desde el fund — un forge no registrado no es fondeable.
    ///         Requiere `token.approve(escrow, amount)` previo (o 3009 en roadmap).
    function fundJob(uint256 amount, address worker) external nonReentrant returns (uint256 jobId) {
        if (amount == 0) revert BadAmount();
        if (forges[worker] == address(0)) revert ForgeNotFound();
        jobId = _nextId++;
        _jobs[jobId] = Job({
            client: msg.sender,
            worker: worker,
            amount: amount,
            state: JobState.Funded,
            fundedAt: uint64(block.timestamp),
            resultHash: bytes32(0)
        });
        emit Funded(jobId, msg.sender, worker, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Paga el escrow al worker del job, atado al sha256 del resultado.
    ///         Proof L0: `forge_sig` es firma personal-sign del forge sobre
    ///         keccak256(resultHash ‖ jobId). caller ∈ {admin, job.worker} —
    ///         el forge puede self-claim si el operador no liquida.
    function release(uint256 jobId, bytes32 resultHash, bytes calldata forgeSig) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.client == address(0)) revert JobNotFound();
        if (msg.sender != admin && msg.sender != job.worker) revert Unauthorized();
        if (job.state != JobState.Funded) revert BadState();
        address signer = forges[job.worker];
        if (signer == address(0)) revert ForgeNotFound();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(resultHash, jobId))
        );
        if (digest.recover(forgeSig) != signer) revert BadSignature();
        job.state = JobState.Released;
        job.resultHash = resultHash;
        emit Released(jobId, job.worker, job.amount, resultHash);
        token.safeTransfer(job.worker, job.amount);
    }

    /// @notice Devuelve el escrow al cliente — SOLO tras la ventana de claim:
    ///         si el worker no claimeó en 24h, la plata vuelve. Antes es un rug
    ///         del trabajo ya servido → TooEarly.
    function refund(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.client == address(0)) revert JobNotFound();
        if (msg.sender != job.client && msg.sender != admin) revert Unauthorized();
        if (job.state != JobState.Funded) revert BadState();
        if (block.timestamp < job.fundedAt + CLAIM_WINDOW) revert TooEarly();
        job.state = JobState.Refunded;
        emit Refunded(jobId, job.client, job.amount);
        token.safeTransfer(job.client, job.amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        Job memory job = _jobs[jobId];
        if (job.client == address(0)) revert JobNotFound();
        return job;
    }
}
