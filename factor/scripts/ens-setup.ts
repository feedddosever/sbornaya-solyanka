/**
 * ENSv2 one-time setup. Run this BEFORE the demo, never during it.
 *
 *   npx tsx scripts/ens-setup.ts
 *
 * Steps 1-4 are infrastructure; step 5 is the part you show a judge. The whole
 * script is idempotent-ish: it logs what it finds and skips what already exists,
 * so you can re-run it after a partial failure.
 *
 * ✅ VERIFIED 2026-09-11 against the ENSv2 Subregistry Lab
 *    (https://github.com/yashgo0018/subregistry-lab), which the ETHRome prizes
 *    page links as the reference implementation. Addresses, the
 *    `VerifiableFactory.deployProxy` signature, BOTH proxy initializers and the
 *    role bitmaps all match contracts-v2 @97a5729 (Sepolia set, 2026-07-30).
 *
 * The non-obvious part, and the thing that silently breaks a from-scratch
 * attempt: `deployProxy`'s third argument is NOT empty calldata. Each proxy
 * must be initialised in the same transaction, with the implementation's own
 * `initialize` encoded into that `data` field:
 *
 *     UserRegistry         initialize(address rootAccount, uint256 roleBitmap)
 *     PermissionedResolver initialize(address admin, uint256 roleBitmap, bytes[] setters)
 *
 * Pass `"0x"` instead and the proxy deploys fine, emits its event, and then
 * every downstream call fails with no obvious cause.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  encodeFunctionData,
  keccak256,
  stringToBytes,
  namehash,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  ENSV2,
  BUSINESS_ROLE_BITMAP,
  ALL_ROLES,
  DANGEROUS_ROOT_BITMAP,
  TEXT_KEYS,
} from "../src/ens/config";
import { labelId, rootRegistry, subregistryOf, nameState } from "../src/ens/read";

const PARENT_LABEL = process.env.ENS_PARENT_LABEL ?? "factor";
const BUSINESSES = (process.env.ENS_BUSINESSES ?? "acme,northwind").split(",");

const pk = process.env.SEPOLIA_PK as `0x${string}`;
if (!pk) throw new Error("set SEPOLIA_PK (needs Sepolia ETH and MockUSDC)");

const account = privateKeyToAccount(pk);
const pubClient = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC) });

// --- ABIs -------------------------------------------------------------------

const registryAbi = parseAbi([
  "function setSubregistry(uint256 anyId, address subregistry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function grantRootRoles(uint256 roleBitmap, address account)",
  "function revokeRootRoles(uint256 roleBitmap, address account)",
  "function getState(uint256 anyId) view returns (uint8,uint64,address,uint256,uint256)",
]);

/** Verified against subregistry-lab src/config/abis.ts. */
const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);

/** The two proxy initializers. These MUST be encoded into `deployProxy`'s
 *  `data` argument - see the header comment. */
const userRegistryInitAbi = parseAbi([
  "function initialize(address rootAccount, uint256 roleBitmap)",
]);
const resolverInitAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap, bytes[] setters)",
]);

/** Does this account hold every bit of `roleBitmap` at registry/resolver root?
 *  Present on both PermissionedRegistry and PermissionedResolver. */
const rolesAbi = parseAbi([
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account)",
  "function revokeRootRoles(uint256 roleBitmap, address account)",
]);

/**
 * CREATE2 salt for deployProxy.
 *
 * The factory mixes msg.sender into the salt, so the same sender reusing the
 * same salt REVERTS on address collision. Derive a fresh one per attempt -
 * a retry after a failed transaction needs a new salt, not the old one.
 */
function deriveSalt(tag: string, nonce = crypto.randomUUID()): bigint {
  return BigInt(keccak256(stringToBytes(`factor:${tag}:${nonce}`)));
}

const resolverAbi = parseAbi([
  "function setAddr(bytes32 node, address a)",
  "function setText(bytes32 node, string key, string value)",
  "function setPubkey(bytes32 node, bytes32 x, bytes32 y)",
  "function authorizeTextRoles(bytes name, string key, address account, bool grant)",
  "function authorizeAddrRoles(bytes name, uint256 coinType, address account, bool grant)",
  "function authorizeNameRoles(bytes name, uint256 roleBitmap, address account, bool grant)",
]);

/** DNS wire format: length-prefixed labels, null terminated. ENSv2's
 *  authorize* functions take names in this encoding, not as namehashes. */
function dnsEncode(name: string): `0x${string}` {
  const parts = name.split(".").filter(Boolean);
  const bytes: number[] = [];
  for (const p of parts) {
    const b = new TextEncoder().encode(p);
    if (b.length > 63) throw new Error(`label too long: ${p}`);
    bytes.push(b.length, ...b);
  }
  bytes.push(0);
  return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
}

async function main() {
  console.log(`\n=== Factor ENSv2 setup (Sepolia) ===`);
  console.log(`operator      ${account.address}`);

  // 0. Sanity-check the deployment we are talking to.
  const root = await rootRegistry();
  console.log(`RootRegistry  ${root}  (derived via ETHRegistry.getParent())`);

  // 1. The parent name. Registering `${PARENT_LABEL}.eth` through the
  //    production ETHRegistrar uses commit-reveal (min 60s, max 1 day) and
  //    charges MockUSDC. If you already own it, this just reports state.
  const parentState = await nameState(ENSV2.ethRegistry as `0x${string}`, PARENT_LABEL);
  console.log(
    `parent        ${PARENT_LABEL}.eth -> ${parentState.statusLabel}, owner ${parentState.latestOwner}`,
  );
  if (parentState.status !== 2) {
    console.log(
      `\n  ${PARENT_LABEL}.eth is not registered to you yet.\n` +
        `  Register it via the ETHRegistrar (${ENSV2.ethRegistrar}) - remember it\n` +
        `  charges MockUSDC (${ENSV2.mockUsdc}), not ETH, and uses commit-reveal.\n` +
        `  Then re-run this script.\n`,
    );
    return;
  }

  // 2. Deploy the UserRegistry proxy. THIS is what lets a name operate its own
  //    registry - the core ENSv2 capability the bounty is asking about.
  let userRegistry = process.env.ENS_USER_REGISTRY as `0x${string}` | undefined;
  if (!userRegistry) {
    console.log(`\ndeploying UserRegistry proxy via VerifiableFactory...`);
    const hash = await wallet.writeContract({
      address: ENSV2.verifiableFactory as `0x${string}`,
      abi: factoryAbi,
      functionName: "deployProxy",
      args: [
        ENSV2.userRegistryImpl as `0x${string}`,
        deriveSalt(PARENT_LABEL),
        // Initialise in the same transaction, granting ourselves everything.
        encodeFunctionData({
          abi: userRegistryInitAbi,
          functionName: "initialize",
          args: [account.address, ALL_ROLES],
        }),
      ],
    });
    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({
      abi: factoryAbi,
      eventName: "ProxyDeployed",
      logs: receipt.logs,
    });
    userRegistry = ev?.args?.proxyAddress;
    if (!userRegistry) throw new Error("ProxyDeployed event not found in receipt");
    console.log(`  UserRegistry  ${userRegistry}`);

    // Verify the initializer actually ran. If `data` had been empty the deploy
    // would still have succeeded, so this read is the real check.
    const ok = await pubClient.readContract({
      address: userRegistry,
      abi: rolesAbi,
      functionName: "hasRootRoles",
      args: [ALL_ROLES, account.address],
    });
    console.log(`  initialised   ${ok ? "yes - you hold ALL_ROLES" : "NO - proxy is uninitialised!"}`);
    if (!ok) throw new Error("registry deployed but not initialised; check the init calldata");
    console.log(`  -> save this as ENS_USER_REGISTRY to skip redeploying`);
  } else {
    console.log(`\nUserRegistry  ${userRegistry} (from env)`);
  }

  // 3. Wire it into the hierarchy. Until this lands, subnames registered in
  //    the UserRegistry have tokens but NEVER resolve - the classic false start.
  const wired = await subregistryOf(PARENT_LABEL);
  if (wired.toLowerCase() !== userRegistry!.toLowerCase()) {
    console.log(`\nwiring ${PARENT_LABEL}.eth -> UserRegistry via setSubregistry...`);
    const hash = await wallet.writeContract({
      address: ENSV2.ethRegistry as `0x${string}`,
      abi: registryAbi,
      functionName: "setSubregistry",
      args: [labelId(PARENT_LABEL), userRegistry!],
    });
    await pubClient.waitForTransactionReceipt({ hash });
    console.log(`  done: ${hash}`);
  } else {
    console.log(`\nsubregistry already wired`);
  }

  // 4. A PermissionedResolver for the platform. In ENSv2 there is no shared
  //    well-known resolver address any more - each account deploys its own.
  let resolver = process.env.ENS_RESOLVER as `0x${string}` | undefined;
  if (!resolver) {
    console.log(`\ndeploying PermissionedResolver proxy...`);
    const hash = await wallet.writeContract({
      address: ENSV2.verifiableFactory as `0x${string}`,
      abi: factoryAbi,
      functionName: "deployProxy",
      args: [
        ENSV2.permissionedResolverImpl as `0x${string}`,
        deriveSalt(`${PARENT_LABEL}-resolver`),
        // Note the third arg: `setters` is an empty bytes[] unless you want to
        // multicall record writes at init time.
        encodeFunctionData({
          abi: resolverInitAbi,
          functionName: "initialize",
          args: [account.address, ALL_ROLES, []],
        }),
      ],
    });
    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({
      abi: factoryAbi,
      eventName: "ProxyDeployed",
      logs: receipt.logs,
    });
    resolver = ev?.args?.proxyAddress;
    if (!resolver) throw new Error("ProxyDeployed event not found for the resolver");
    console.log(`  resolver      ${resolver}`);
    console.log(`  -> save this as ENS_RESOLVER`);
  } else {
    console.log(`\nresolver      ${resolver} (from env)`);
  }

  // 5. Issue one subname per business, with records and a delegated accountant.
  const accountant = process.env.ENS_ACCOUNTANT_ADDR as `0x${string}` | undefined;
  const oneYear = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);

  for (const label of BUSINESSES) {
    const full = `${label}.${PARENT_LABEL}.eth`;
    const state = await nameState(userRegistry!, label);

    if (state.status !== 2) {
      console.log(`\nregistering ${full}...`);
      const hash = await wallet.writeContract({
        address: userRegistry!,
        abi: registryAbi,
        functionName: "register",
        args: [
          label,
          account.address,
          "0x0000000000000000000000000000000000000000",
          resolver!,
          BUSINESS_ROLE_BITMAP,
          oneYear,
        ],
      });
      await pubClient.waitForTransactionReceipt({ hash });
      console.log(`  registered: ${hash}`);
    } else {
      console.log(`\n${full} already registered (expires ${state.expiresAt.toISOString()})`);
    }

    // Records. A fresh name resolves to NOTHING until records are written -
    // registration and resolution are separate steps in v2.
    const node = namehash(full);
    console.log(`  writing records for ${full}...`);
    await pubClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: resolver!,
        abi: resolverAbi,
        functionName: "setAddr",
        args: [node, account.address],
      }),
    });
    await pubClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: resolver!,
        abi: resolverAbi,
        functionName: "setText",
        args: [node, TEXT_KEYS.sector, label === "acme" ? "logistics" : "manufacturing"],
      }),
    });

    // 5b. THE DEMO MOMENT. Grant the accountant exactly ONE text key. They will
    //     be able to update the contact record and will be REVERTED with
    //     EACUnauthorizedAccountRoles if they try to touch the payout address.
    if (accountant) {
      console.log(`  delegating ONLY '${TEXT_KEYS.contact}' to accountant ${accountant}...`);
      await pubClient.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: resolver!,
          abi: resolverAbi,
          functionName: "authorizeTextRoles",
          args: [dnsEncode(full), TEXT_KEYS.contact, accountant, true],
        }),
      });
      console.log(`  -> demo: accountant edits contact OK, setAddr REVERTS`);
    }
  }

  console.log(`\n=== done ===`);
  console.log(`ENS_USER_REGISTRY=${userRegistry}`);
  console.log(`ENS_RESOLVER=${resolver}`);
  console.log(`\nOptional stretch (deep v2) - emancipation:`);
  console.log(`  revokeRootRoles(DANGEROUS_ROOT_BITMAP, ${account.address})`);
  console.log(`  on ${userRegistry}`);
  console.log(`\n  bitmap = 0x${DANGEROUS_ROOT_BITMAP.toString(16)}`);
  console.log(`  After that you provably cannot delete, renew, repoint or upgrade a`);
  console.log(`  business's name. ROLE_REGISTRAR is deliberately NOT in that bitmap,`);
  console.log(`  so you can still issue NEW names - emancipation need not end the`);
  console.log(`  product. RUN IT ON A THROWAWAY NAME FIRST: revoke in the wrong`);
  console.log(`  order and you lock yourself out before setup finishes.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
