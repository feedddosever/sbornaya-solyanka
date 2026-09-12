// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Grant the claim contract an FUSD allowance from a financier account.
///
/// WHY THIS EXISTS. `InvoiceClaim.sell` is called by the HOLDER but moves money
/// from the BUYER:
///
///     stable.safeTransferFrom(buyer, holder, price);
///
/// so the buyer must have approved the claim contract beforehand. That mirrors
/// how a financier really operates — you grant a standing allowance once, then
/// fills happen without you signing each one — but it means a demo where nobody
/// ever approved fails at the most important moment with "insufficient
/// allowance". Run this once per financier key before demoing.
///
/// Usage (once per financier):
///   PRIVATE_KEY=$ARKIV_FIN1_PK ... no: use the FUJI key for that financier
///   PRIVATE_KEY=<financier key> \
///   FUSD_ADDRESS=0x.. CLAIM_ADDRESS=0x.. \
///   forge script script/Approve.s.sol --rpc-url fuji --broadcast
contract Approve is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        IERC20 fusd = IERC20(vm.envAddress("FUSD_ADDRESS"));
        address claim = vm.envAddress("CLAIM_ADDRESS");

        // A standing allowance. Testnet mock money, so a large round number is
        // fine and saves re-approving between rehearsals.
        uint256 amount = vm.envOr("APPROVE_AMOUNT", uint256(250_000e6));

        vm.startBroadcast(pk);
        fusd.approve(claim, amount);
        vm.stopBroadcast();

        console.log("approved %s FUSD units", amount);
        console.log("  owner   %s", me);
        console.log("  spender %s", claim);
        console.log("  allowance now %s", fusd.allowance(me, claim));
    }
}
