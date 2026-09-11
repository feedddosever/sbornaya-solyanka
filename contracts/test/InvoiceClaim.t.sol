// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FUSD} from "../src/FUSD.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract InvoiceClaimTest is Test {
    FUSD internal fusd;
    InvoiceClaim internal claim;

    address internal platform = address(0xA11CE);
    address internal acme = address(0xACC1); // issuer (SME)
    address internal debtor = address(0xDEB7);
    address internal financier = address(0xF1);
    address internal financier2 = address(0xF2);
    address internal stranger = address(0xBAD);

    uint256 internal constant FACE = 10_000e6; // 10,000 FUSD
    uint64 internal dueDate;

    event Sold(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint256 price,
        bytes32 arkivBidKey
    );
    event Settled(uint256 indexed id, address indexed paidTo, uint256 amount);

    function setUp() public {
        vm.warp(1_800_000_000); // a fixed, sane "now"
        dueDate = uint64(block.timestamp + 60 days);

        vm.prank(platform);
        fusd = new FUSD();
        vm.prank(platform);
        claim = new InvoiceClaim(IERC20(address(fusd)));

        address[] memory allowed = new address[](4);
        allowed[0] = acme;
        allowed[1] = financier;
        allowed[2] = financier2;
        allowed[3] = debtor;
        vm.prank(platform);
        claim.setEligibleBatch(allowed, true);

        fusd.mint(financier, 1_000_000e6);
        fusd.mint(financier2, 1_000_000e6);
        fusd.mint(debtor, 1_000_000e6);
    }

    function _issue() internal returns (uint256 id) {
        vm.prank(acme);
        id = claim.issue(debtor, FACE, dueDate, keccak256("swarm-ref"));
    }

    // ------------------------------------------------------------- issuance

    function test_Issue_MintsToIssuerAndStoresTerms() public {
        uint256 id = _issue();

        assertEq(claim.ownerOf(id), acme, "issuer should hold the fresh claim");
        (
            address d,
            address i,
            uint256 fv,
            uint64 dd,
            bytes32 dh,
            bool settled
        ) = claim.invoices(id);
        assertEq(d, debtor);
        assertEq(i, acme);
        assertEq(fv, FACE);
        assertEq(dd, dueDate);
        assertEq(dh, keccak256("swarm-ref"));
        assertFalse(settled);
        assertTrue(claim.isOutstanding(id));
    }

    function test_Issue_IncrementsIds() public {
        uint256 a = _issue();
        uint256 b = _issue();
        assertEq(b, a + 1);
    }

    function test_RevertWhen_IssuerNotEligible() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, stranger));
        claim.issue(debtor, FACE, dueDate, bytes32(0));
    }

    function test_RevertWhen_FaceValueZero() public {
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadFaceValue.selector);
        claim.issue(debtor, 0, dueDate, bytes32(0));
    }

    function test_RevertWhen_DueDateInPast() public {
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadDueDate.selector);
        claim.issue(debtor, FACE, uint64(block.timestamp - 1), bytes32(0));
    }

    // ------------------------------------------------------- POLICY: eligibility

    function test_RevertWhen_SellingToIneligibleBuyer() public {
        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, stranger));
        claim.sell(id, stranger, 9_700e6, bytes32(0));
    }

    /// The policy must hold even when someone bypasses `sell` and uses the raw
    /// ERC-721 path. This is the test that proves the hook, not the wrapper.
    function test_RevertWhen_DirectTransferToIneligible() public {
        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, stranger));
        claim.transferFrom(acme, stranger, id);
    }

    function test_RevokingEligibilityBlocksFutureTransfers() public {
        uint256 id = _issue();

        vm.prank(platform);
        claim.setEligible(financier, false);

        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, financier));
        claim.transferFrom(acme, financier, id);
    }

    function test_RevertWhen_NonOwnerSetsEligibility() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        claim.setEligible(stranger, true);
    }

    // ------------------------------------------------------------ RULE: maturity

    function test_RevertWhen_TransferAtOrAfterMaturity() public {
        uint256 id = _issue();
        vm.warp(dueDate); // exactly at maturity - boundary is inclusive

        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.PastMaturity.selector, id));
        claim.transferFrom(acme, financier, id);
    }

    function test_TransferAllowedOneSecondBeforeMaturity() public {
        uint256 id = _issue();
        vm.warp(uint256(dueDate) - 1);

        vm.prank(acme);
        claim.transferFrom(acme, financier, id);
        assertEq(claim.ownerOf(id), financier);
    }

    // ------------------------------------------------------------------- sale

    function test_Sell_MovesClaimAndCash() public {
        uint256 id = _issue();
        uint256 price = 9_700e6; // 3% discount

        vm.prank(financier);
        fusd.approve(address(claim), price);

        uint256 acmeBefore = fusd.balanceOf(acme);
        uint256 finBefore = fusd.balanceOf(financier);

        vm.prank(acme);
        claim.sell(id, financier, price, keccak256("arkiv-bid-1"));

        assertEq(claim.ownerOf(id), financier, "claim should move to the financier");
        assertEq(fusd.balanceOf(acme), acmeBefore + price, "issuer receives discounted cash");
        assertEq(fusd.balanceOf(financier), finBefore - price);
    }

    function test_Sell_EmitsArkivBidKey() public {
        uint256 id = _issue();
        uint256 price = 9_700e6;
        bytes32 bidKey = keccak256("arkiv-bid-42");

        vm.prank(financier);
        fusd.approve(address(claim), price);

        vm.expectEmit(true, true, true, true);
        emit Sold(id, acme, financier, price, bidKey);

        vm.prank(acme);
        claim.sell(id, financier, price, bidKey);
    }

    function test_RevertWhen_SellerIsNotHolder() public {
        uint256 id = _issue();
        vm.prank(financier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotHolder.selector, financier));
        claim.sell(id, financier2, 1e6, bytes32(0));
    }

    function test_RevertWhen_SellingToSelf() public {
        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.SelfPurchase.selector);
        claim.sell(id, acme, 1e6, bytes32(0));
    }

    function test_RevertWhen_BuyerHasNotApproved() public {
        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(); // SafeERC20 insufficient allowance
        claim.sell(id, financier, 9_700e6, bytes32(0));
    }

    function test_SecondaryResaleBetweenFinanciers() public {
        uint256 id = _issue();

        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);
        vm.prank(acme);
        claim.sell(id, financier, 9_700e6, bytes32("bid1"));

        vm.prank(financier2);
        fusd.approve(address(claim), 9_850e6);
        vm.prank(financier);
        claim.sell(id, financier2, 9_850e6, bytes32("bid2"));

        assertEq(claim.ownerOf(id), financier2);
    }

    // -------------------------------------------------------------- settlement

    function test_Settle_PaysHolderAndBurns() public {
        uint256 id = _issue();

        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);
        vm.prank(acme);
        claim.sell(id, financier, 9_700e6, bytes32("bid"));

        vm.prank(debtor);
        fusd.approve(address(claim), FACE);

        uint256 finBefore = fusd.balanceOf(financier);

        vm.expectEmit(true, true, false, true);
        emit Settled(id, financier, FACE);

        vm.prank(debtor);
        claim.settle(id);

        assertEq(fusd.balanceOf(financier), finBefore + FACE, "holder receives full face value");
        assertFalse(claim.isOutstanding(id));
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id)
        );
        claim.ownerOf(id);
    }

    /// A matured claim cannot be traded but MUST still be payable. If this test
    /// ever fails, the hook is over-reaching and real invoices would be stranded.
    function test_Settle_StillWorksAfterMaturity() public {
        uint256 id = _issue();
        vm.warp(uint256(dueDate) + 10 days);

        vm.prank(debtor);
        fusd.approve(address(claim), FACE);
        vm.prank(debtor);
        claim.settle(id);

        assertFalse(claim.isOutstanding(id));
    }

    function test_RevertWhen_SettlingTwice() public {
        uint256 id = _issue();
        vm.prank(debtor);
        fusd.approve(address(claim), FACE * 2);
        vm.prank(debtor);
        claim.settle(id);

        vm.prank(debtor);
        vm.expectRevert(); // token burned - _requireOwned reverts first
        claim.settle(id);
    }

    function test_RevertWhen_SettlerIsNotDebtor() public {
        uint256 id = _issue();
        vm.prank(financier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotDebtor.selector, financier));
        claim.settle(id);
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_SellThenSettleConservesValue(uint128 faceRaw, uint128 priceRaw) public {
        uint256 face = uint256(faceRaw) + 1; // non-zero
        uint256 price = uint256(priceRaw);
        vm.assume(price <= 1_000_000e6);

        vm.prank(acme);
        uint256 id = claim.issue(debtor, face, dueDate, bytes32(0));

        vm.prank(financier);
        fusd.approve(address(claim), price);
        vm.prank(acme);
        claim.sell(id, financier, price, bytes32(0));

        fusd.mint(debtor, face);
        vm.prank(debtor);
        fusd.approve(address(claim), face);

        uint256 finBefore = fusd.balanceOf(financier);
        vm.prank(debtor);
        claim.settle(id);

        // The financier's return is exactly face value, whatever they paid.
        assertEq(fusd.balanceOf(financier), finBefore + face);
    }

    function testFuzz_EligibilityGateIsTotal(address who) public {
        vm.assume(who != address(0));
        vm.assume(who != acme && who != financier && who != financier2 && who != debtor);
        vm.assume(who.code.length == 0); // skip contracts that reject ERC721

        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, who));
        claim.transferFrom(acme, who, id);
    }
}
