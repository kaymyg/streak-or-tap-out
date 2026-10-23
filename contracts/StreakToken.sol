// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title StreakToken
/// @notice Fixed-cap ERC-20. Base-native: the Base<>Solana bridge escrows this
///         contract's tokens and mints a wrapped SPL on the far side, so no
///         CrossChainERC20 extension is needed here.
contract StreakToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    error CapExceeded(uint256 requested, uint256 remaining);

    constructor() ERC20("Streak", "STREAK") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function mint(address to, uint256 amt) external onlyRole(MINTER_ROLE) {
        uint256 remaining = MAX_SUPPLY - totalSupply();
        if (amt > remaining) revert CapExceeded(amt, remaining);
        _mint(to, amt);
    }
}
