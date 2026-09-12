/**
 * ENSv2 beta on Sepolia.
 *
 * ✅ VERIFIED 2026-09-11 against TWO independent sources that agree:
 *
 *   1. ensjs `packages/ensjs/src/clients/l1.ts` (main)
 *   2. the ENSv2 Subregistry Lab, linked from the ETHRome prizes page:
 *      https://github.com/yashgo0018/subregistry-lab  (src/config/deployments.ts)
 *
 * Both track contracts-v2 `contracts/deployments/sepolia` at commit
 * 97a57293f3b4279d94b571e678edb53ce62638f4 (Sepolia set, 2026-07-30). The
 * ensjs PR #353 redeployment that proposed different addresses evidently did
 * NOT land, so the values below are current.
 *
 * ABI artifacts, if you need them:
 * https://github.com/ensdomains/contracts-v2/tree/97a57293f3b4279d94b571e678edb53ce62638f4/contracts/deployments/sepolia
 */
export const SEPOLIA_CHAIN_ID = 11155111;

export const ENSV2 = {
  /** The public resolve entrypoint: UpgradableUniversalResolverProxy, which
   *  delegates to UniversalResolverV2. This is what the ENS app and viem use. */
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  /** The implementation behind that proxy, if you need to read it directly. */
  universalResolverV2Impl: "0x4A1817d13E9cF196f471725176355C1234b63C70",
  ethRegistry: "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2",
  ethRegistrar: "0xa88553F454b77203B0D036A05c894d555EAAa2Cc",
  verifiableFactory: "0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef",
  permissionedResolverImpl: "0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e",
  userRegistryImpl: "0x624a25d67B59D587752EbEc8DdeD8827dAe52050",
  standardRentPriceOracle: "0x8914b66260EB8C4fff795650c3AE8Cd335958987",
  /** The ETHRegistrar charges in MockUSDC, NOT in ETH. Sepolia ETH alone is
   *  not enough to register a name - mint yourself some of this first. */
  mockUsdc: "0x768F42455A2D082E23ceeF7d51e5787C82d67a39",
  mockDai: "0x5472C5725A00B7bA11F0794A79D08ade6F4683bD",
  /** Not published anywhere. Derive it on-chain: ETHRegistry.getParent()
   *  returns (rootRegistryAddress, "eth"). */
  rootRegistry: null as `0x${string}` | null,
} as const;

/** Log-scan starting blocks, so historical queries don't walk all of Sepolia. */
export const FACTORY_DEPLOY_BLOCK = 11383823n;
export const ETH_REGISTRY_DEPLOY_BLOCK = 11383897n;

/** Tenderly's public gateway accepts full-range `eth_getLogs`; the common
 *  public transports cap or reject historical ranges (drpc's free tier rejects
 *  anything over 10,000 blocks). Verified by the Subregistry Lab. */
export const LOG_SCAN_RPC = "https://sepolia.gateway.tenderly.co";
export const LOG_CHUNK_SIZE = 9_999n;

/**
 * RegistryRolesLib - verified from the raw source of
 * ensdomains/contracts-v2 `contracts/src/registry/libraries/RegistryRolesLib.sol`.
 *
 * The admin counterpart of every role is `role << 128`, and to GRANT role X you
 * must hold X_ADMIN.
 */
const shift = (n: bigint) => 1n << n;
export const ROLE = {
  REGISTRAR: shift(0n),
  REGISTER_RESERVED: shift(4n),
  SET_PARENT: shift(8n),
  UNREGISTER: shift(12n),
  RENEW: shift(16n),
  SET_SUBREGISTRY: shift(20n),
  SET_RESOLVER: shift(24n),
  WAS_RESERVED: shift(32n),
  SET_URI: shift(36n),
  CAN_NAME: shift(120n),
  UPGRADE: shift(124n),
} as const;

export const admin = (role: bigint) => role << 128n;

/** ERC-1155 transfers revert with TransferDisallowed unless the owner holds
 *  this. Note it is admin-only - there is no non-admin counterpart. So
 *  non-transferable names are ENSv2's DEFAULT, which is a design primitive
 *  rather than a limitation. */
export const ROLE_CAN_TRANSFER_ADMIN = shift(28n) << 128n;

/** `EACBaseRolesLib.ALL_ROLES` - every role nybble set in both halves. This is
 *  what you pass as the initializer bitmap when deploying your own registry or
 *  resolver, so the deployer starts with full control. */
export const ALL_ROLES = BigInt(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

/** What Factor grants a business when issuing its subname: control of its own
 *  resolver and subregistry, plus the ability to transfer the name.
 *
 *  Verified to mirror the ETHRegistrar's own `REGISTRATION_ROLE_BITMAP` - the
 *  Subregistry Lab has a golden test asserting exactly this composition, so a
 *  business subname here carries the same rights a real `.eth` registration
 *  does. */
export const BUSINESS_ROLE_BITMAP =
  ROLE.SET_RESOLVER |
  admin(ROLE.SET_RESOLVER) |
  ROLE.SET_SUBREGISTRY |
  admin(ROLE.SET_SUBREGISTRY) |
  ROLE_CAN_TRANSFER_ADMIN;

/**
 * The roles that let their holder take a name away or break the setup.
 *
 * Revoking this bitmap from yourself on your own UserRegistry is the
 * "emancipation" move: afterwards the platform provably cannot delete, renew,
 * repoint or upgrade a business's name. Note what is deliberately NOT in here -
 * `ROLE_REGISTRAR`. Keeping the ability to register NEW names costs a business
 * nothing, so emancipation does not have to end the product.
 *
 * Composition cross-checked against the Subregistry Lab's DANGEROUS_ROOT_BITMAP
 * assertions.
 */
export const DANGEROUS_ROOT_BITMAP =
  ROLE.UNREGISTER |
  admin(ROLE.UNREGISTER) |
  ROLE.SET_SUBREGISTRY |
  admin(ROLE.SET_SUBREGISTRY) |
  ROLE.RENEW |
  admin(ROLE.RENEW) |
  ROLE.UPGRADE |
  admin(ROLE.UPGRADE);

/** PermissionedResolver roles (docs.ens.domains/ensv2/permissioned-resolver). */
export const RESOLVER_ROLE = {
  SET_ADDR: shift(0n),
  SET_TEXT: shift(4n),
  SET_CONTENTHASH: shift(8n),
  SET_PUBKEY: shift(12n),
  SET_ABI: shift(16n),
  SET_INTERFACE: shift(20n),
  SET_NAME: shift(24n),
  SET_ALIAS: shift(28n), // root scope only
  CLEAR: shift(32n),
  SET_DATA: shift(36n),
  UPGRADE: shift(124n),
} as const;

/** Text record keys Factor writes. */
export const TEXT_KEYS = {
  sector: "factor.sector",
  contact: "factor.contact",
  rating: "factor.rating",
} as const;
