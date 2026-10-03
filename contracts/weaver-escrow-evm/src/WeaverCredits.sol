// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title WeaverCredits — depósitos on-chain que acreditan una Account (ADR-0008)
/// @notice EVM no tiene memo: el `account` viaja en calldata. El gateway
///         escucha `Deposited` y hace `topup` en el CreditLedger.
///         Reemplaza al DepositWatcher de Horizon.
contract WeaverCredits {
    using SafeERC20 for IERC20;
    address public immutable admin;
    IERC20 public immutable token;

    /// @param account accountId del Account layer (keccak256 del "acct_…" id,
    ///        definido por el gateway — el contrato es agnóstico al formato)
    event Deposited(bytes32 indexed account, address indexed payer, uint256 amount);

    error BadAmount();

    constructor(address token_) {
        admin = msg.sender;
        token = IERC20(token_);
    }

    /// @notice Deposita USDC a favor de `account`. Requiere approve previo.
    function deposit(bytes32 account, uint256 amount) external {
        if (amount == 0) revert BadAmount();
        emit Deposited(account, msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice El operador retira el float acumulado a su wallet.
    function sweep(uint256 amount) external {
        require(msg.sender == admin, "not admin");
        token.safeTransfer(admin, amount);
    }
}
