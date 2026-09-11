// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";

/// @notice Issues one invoice so the market page is never empty on stage, and
///         so you always have a spare claim in reserve if the live one is
///         consumed during a rehearsal.
///
/// Usage:
///   CLAIM_ADDRESS=0x.. DOC_HASH=0x.. forge script script/DemoSeed.s.sol \
///     --rpc-url fuji --broadcast
contract DemoSeed is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        InvoiceClaim claim = InvoiceClaim(vm.envAddress("CLAIM_ADDRESS"));
        address debtor = vm.envAddress("DEBTOR_ADDR");

        // keccak256 of the encrypted Swarm reference. Commitment only - never
        // publish the reference itself, it carries its own decryption key.
        bytes32 docHash = vm.envOr("DOC_HASH", keccak256("factor-demo-placeholder"));

        uint64 due = uint64(block.timestamp + 45 days);

        vm.startBroadcast(pk);
        uint256 id = claim.issue(debtor, 12_500e6, due, docHash);
        vm.stopBroadcast();

        console.log("Issued invoice id %s, face 12500 FUSD, due in 45 days", id);
    }
}
