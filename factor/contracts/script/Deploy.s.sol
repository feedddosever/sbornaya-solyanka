// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FUSD} from "../src/FUSD.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys FUSD + InvoiceClaim to Fuji, onboards the demo accounts and
///         funds them, so the app has something to read the moment it boots.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url fuji --broadcast -vvv
///
/// Env:
///   PRIVATE_KEY   deployer / platform owner (needs Fuji AVAX)
///   ISSUER_ADDR   the SME account (defaults to deployer)
///   DEBTOR_ADDR   the paying party
///   FIN1_ADDR     financier 1
///   FIN2_ADDR     financier 2
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address issuer = vm.envOr("ISSUER_ADDR", deployer);
        address debtor = vm.envOr("DEBTOR_ADDR", deployer);
        address fin1 = vm.envOr("FIN1_ADDR", deployer);
        address fin2 = vm.envOr("FIN2_ADDR", deployer);

        vm.startBroadcast(pk);

        FUSD fusd = new FUSD();
        InvoiceClaim claim = new InvoiceClaim(IERC20(address(fusd)));

        // Onboard everyone who needs to hold or pay for a claim.
        address[] memory allowed = new address[](4);
        allowed[0] = issuer;
        allowed[1] = debtor;
        allowed[2] = fin1;
        allowed[3] = fin2;
        claim.setEligibleBatch(allowed, true);

        // Fund the demo. FUSD has 6 decimals.
        fusd.mint(debtor, 500_000e6); // enough to settle
        fusd.mint(fin1, 250_000e6);
        fusd.mint(fin2, 250_000e6);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Factor deployed to Fuji (43113) ===");
        console.log("FUSD         ", address(fusd));
        console.log("InvoiceClaim ", address(claim));
        console.log("");
        console.log("Put these in .env.local as:");
        console.log("  NEXT_PUBLIC_FUSD_ADDRESS=%s", address(fusd));
        console.log("  NEXT_PUBLIC_CLAIM_ADDRESS=%s", address(claim));
        console.log("");
        console.log("Verify with:");
        console.log("  forge verify-contract --chain-id 43113 \\");
        console.log("    --etherscan-api-key $SNOWTRACE_API_KEY \\");
        console.log("    %s src/InvoiceClaim.sol:InvoiceClaim \\", address(claim));
        console.log("    --constructor-args $(cast abi-encode 'c(address)' %s)", address(fusd));
    }
}
