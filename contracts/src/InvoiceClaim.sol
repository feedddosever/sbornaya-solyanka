// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title InvoiceClaim - a tokenised invoice with a rule, a policy and a settlement
/// @notice Factor turns an unpaid invoice into a transferable claim an SME can sell
///         at a discount before its due date. Three things are enforced on-chain:
///
///           RULE      a claim cannot change hands once it reaches maturity
///           POLICY    only eligible accounts may hold a claim
///           SETTLE    the debtor pays face value to whoever holds the claim,
///                     and the claim retires
///
/// @dev On the policy layer: Avalanche's AllowList precompiles (TxAllowList and
///      friends) are Subnet-EVM genesis features and DO NOT exist on Fuji C-Chain,
///      so eligibility here is an ordinary Solidity mapping checked in the ERC-721
///      transfer hook. On C-Chain that is the correct implementation, not a
///      workaround. See README for the full reasoning.
///
/// @dev The bid book lives off-chain in Arkiv, where each offer carries its own
///      expiry and therefore needs no cancel endpoint. `sell` records the Arkiv
///      entity key of the bid it filled, so an on-chain execution can always be
///      traced back to the exact off-chain offer that produced it.
contract InvoiceClaim is ERC721, Ownable {
    using SafeERC20 for IERC20;

    struct Invoice {
        address debtor; // who owes the money
        address issuer; // the SME that raised the invoice
        uint256 faceValue; // amount owed, in `stable` units
        uint64 dueDate; // maturity, unix seconds - the asset RULE
        bytes32 docHash; // keccak256 of the encrypted Swarm reference
        bool settled;
    }

    /// @notice Settlement currency (FUSD on Fuji).
    IERC20 public immutable stable;

    uint256 public nextId = 1;

    mapping(uint256 tokenId => Invoice) public invoices;

    /// @notice The transfer POLICY. Only eligible accounts may issue or receive claims.
    mapping(address account => bool allowed) public eligible;

    error NotEligible(address who);
    error PastMaturity(uint256 id);
    error AlreadySettled(uint256 id);
    error NotDebtor(address caller);
    error NotHolder(address caller);
    error BadFaceValue();
    error BadDueDate();
    error SelfPurchase();

    event Issued(
        uint256 indexed id,
        address indexed issuer,
        address indexed debtor,
        uint256 faceValue,
        uint64 dueDate,
        bytes32 docHash
    );
    event EligibilitySet(address indexed who, bool allowed);
    event Sold(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint256 price,
        bytes32 arkivBidKey
    );
    event Settled(uint256 indexed id, address indexed paidTo, uint256 amount);

    constructor(IERC20 _stable)
        ERC721("Factor Invoice Claim", "FIC")
        Ownable(msg.sender)
    {
        stable = _stable;
    }

    // ---------------------------------------------------------------- policy

    /// @notice Add or remove an account from the eligibility set.
    /// @dev Centralised on purpose: in production this is the KYC/onboarding
    ///      boundary, and pretending otherwise would be dishonest about the
    ///      trust model. Emitting on every change keeps it auditable.
    function setEligible(address who, bool allowed) external onlyOwner {
        eligible[who] = allowed;
        emit EligibilitySet(who, allowed);
    }

    function setEligibleBatch(address[] calldata who, bool allowed) external onlyOwner {
        for (uint256 i; i < who.length; ++i) {
            eligible[who[i]] = allowed;
            emit EligibilitySet(who[i], allowed);
        }
    }

    // --------------------------------------------------------------- lifecycle

    /// @notice Raise an invoice as a transferable claim, held initially by the issuer.
    /// @param debtor the party that owes the money
    /// @param faceValue amount owed, in `stable` units
    /// @param dueDate maturity as a unix timestamp; must be in the future
    /// @param docHash keccak256 of the encrypted Swarm reference for the full invoice.
    ///        A commitment only - the reference itself must never be published,
    ///        because an encrypted Swarm reference carries its decryption key.
    function issue(address debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash)
        external
        returns (uint256 id)
    {
        if (!eligible[msg.sender]) revert NotEligible(msg.sender);
        if (faceValue == 0) revert BadFaceValue();
        if (dueDate <= block.timestamp) revert BadDueDate();

        id = nextId++;
        invoices[id] = Invoice({
            debtor: debtor,
            issuer: msg.sender,
            faceValue: faceValue,
            dueDate: dueDate,
            docHash: docHash,
            settled: false
        });
        _mint(msg.sender, id);

        emit Issued(id, msg.sender, debtor, faceValue, dueDate, docHash);
    }

    /// @notice Sell the claim to a financier who has already approved `price` of `stable`.
    /// @param arkivBidKey the Arkiv entity key of the expiring bid being filled.
    ///        Recorded so the on-chain trade can be reconciled against the
    ///        off-chain offer book.
    function sell(uint256 id, address buyer, uint256 price, bytes32 arkivBidKey) external {
        address holder = _requireOwned(id);
        if (msg.sender != holder) revert NotHolder(msg.sender);
        if (buyer == holder) revert SelfPurchase();
        if (invoices[id].settled) revert AlreadySettled(id);
        // Eligibility and maturity are enforced in _update; checking the buyer
        // here too gives a clearer revert before any token movement.
        if (!eligible[buyer]) revert NotEligible(buyer);

        stable.safeTransferFrom(buyer, holder, price);
        _transfer(holder, buyer, id);

        emit Sold(id, holder, buyer, price, arkivBidKey);
    }

    /// @notice The debtor pays face value to the current holder; the claim retires.
    /// @dev Deliberately still callable at or after maturity. Trading a matured
    ///      claim is forbidden, but paying one must always be possible - that is
    ///      the whole point of an invoice.
    function settle(uint256 id) external {
        Invoice storage inv = invoices[id];
        address holder = _requireOwned(id);

        if (inv.settled) revert AlreadySettled(id);
        if (msg.sender != inv.debtor) revert NotDebtor(msg.sender);

        inv.settled = true;
        stable.safeTransferFrom(msg.sender, holder, inv.faceValue);
        _burn(id);

        emit Settled(id, holder, inv.faceValue);
    }

    // ------------------------------------------------------------------ views

    function isOutstanding(uint256 id) external view returns (bool) {
        return _ownerOf(id) != address(0) && !invoices[id].settled;
    }

    function daysToMaturity(uint256 id) external view returns (int256) {
        return (int256(uint256(invoices[id].dueDate)) - int256(block.timestamp)) / 1 days;
    }

    // ------------------------------------------------------------------- hook

    /// @dev OpenZeppelin v5 transfer hook. Enforces the policy and the rule on
    ///      every genuine transfer, while allowing mint (from == 0) and burn
    ///      (to == 0) so issuance and settlement are never blocked.
    ///      NOTE: on OZ v4 this hook is `_beforeTokenTransfer` instead.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);

        if (from != address(0) && to != address(0)) {
            if (!eligible[to]) revert NotEligible(to);
            if (block.timestamp >= invoices[tokenId].dueDate) revert PastMaturity(tokenId);
        }

        return super._update(to, tokenId, auth);
    }
}
