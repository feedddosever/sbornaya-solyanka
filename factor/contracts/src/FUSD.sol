// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FUSD - Factor test stablecoin
/// @notice A deliberately trivial, openly mintable ERC-20 standing in for a
///         settlement stablecoin on Avalanche Fuji. It is a TESTNET MOCK: anyone
///         may mint, there is no supply cap and no access control. Do not deploy
///         this to a network where anyone could mistake it for money.
/// @dev 6 decimals to mirror USDC so face values read naturally (1_000_000 = 1 FUSD).
contract FUSD is ERC20 {
    constructor() ERC20("Factor USD (test)", "FUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens to any address. Unrestricted on purpose.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
