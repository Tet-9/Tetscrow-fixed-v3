// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only USDC stand-in (6 decimals) with a blocklist like real USDC.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address a, bool b) external { blocked[a] = b; }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}
