/**
 * Avalanche Fuji C-Chain: the money layer.
 *
 * This is the only layer that can hold value and REVERT a transfer that breaks
 * a rule, which is why the asset lives here and the bid book does not.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  defineChain,
  formatUnits,
  parseUnits,
} from "viem";

export const fuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
  blockExplorers: {
    default: { name: "Snowtrace", url: "https://testnet.snowtrace.io" },
  },
  testnet: true,
});

export const FUSD_DECIMALS = 6;
export const toFusd = (human: string) => parseUnits(human, FUSD_DECIMALS);
export const fromFusd = (raw: bigint) => formatUnits(raw, FUSD_DECIMALS);

export const claimAbi = parseAbi([
  "function issue(address debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash) returns (uint256)",
  "function sell(uint256 id, address buyer, uint256 price, bytes32 arkivBidKey)",
  "function settle(uint256 id)",
  "function setEligible(address who, bool allowed)",
  "function eligible(address) view returns (bool)",
  "function invoices(uint256) view returns (address debtor, address issuer, uint256 faceValue, uint64 dueDate, bytes32 docHash, bool settled)",
  "function ownerOf(uint256) view returns (address)",
  "function isOutstanding(uint256) view returns (bool)",
  "function nextId() view returns (uint256)",
  "event Issued(uint256 indexed id, address indexed issuer, address indexed debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash)",
  "event Sold(uint256 indexed id, address indexed from, address indexed to, uint256 price, bytes32 arkivBidKey)",
  "event Settled(uint256 indexed id, address indexed paidTo, uint256 amount)",
  "event EligibilitySet(address indexed who, bool allowed)",
  "error NotEligible(address who)",
  "error PastMaturity(uint256 id)",
  "error AlreadySettled(uint256 id)",
  "error NotDebtor(address caller)",
  "error NotHolder(address caller)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

export const CLAIM_ADDRESS = process.env.NEXT_PUBLIC_CLAIM_ADDRESS as `0x${string}`;
export const FUSD_ADDRESS = process.env.NEXT_PUBLIC_FUSD_ADDRESS as `0x${string}`;

export const fujiPublic = createPublicClient({ chain: fuji, transport: http() });

/** Browser wallet, for the one layer where a real signature belongs.
 *  Arkiv writes use an in-app signer and ENS setup is a pre-run script, so the
 *  user is never asked to switch networks mid-demo. */
export function fujiWallet() {
  if (typeof window === "undefined" || !(window as any).ethereum) {
    throw new Error("no injected wallet found");
  }
  return createWalletClient({ chain: fuji, transport: custom((window as any).ethereum) });
}

export interface OnChainInvoice {
  id: bigint;
  debtor: `0x${string}`;
  issuer: `0x${string}`;
  faceValue: bigint;
  faceValueHuman: string;
  dueDate: number;
  docHash: `0x${string}`;
  settled: boolean;
  holder: `0x${string}` | null;
  matured: boolean;
}

export async function readInvoice(id: bigint): Promise<OnChainInvoice> {
  const [debtor, issuer, faceValue, dueDate, docHash, settled] =
    await fujiPublic.readContract({
      address: CLAIM_ADDRESS,
      abi: claimAbi,
      functionName: "invoices",
      args: [id],
    });

  const holder = await fujiPublic
    .readContract({ address: CLAIM_ADDRESS, abi: claimAbi, functionName: "ownerOf", args: [id] })
    .catch(() => null);

  return {
    id,
    debtor,
    issuer,
    faceValue,
    faceValueHuman: fromFusd(faceValue),
    dueDate: Number(dueDate),
    docHash,
    settled,
    holder: holder as `0x${string}` | null,
    matured: Number(dueDate) * 1000 <= Date.now(),
  };
}

export async function isEligible(who: `0x${string}`) {
  return fujiPublic.readContract({
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "eligible",
    args: [who],
  });
}

/** Issue an invoice. `docHash` must be keccak256 of the ENCRYPTED Swarm
 *  reference - a commitment, never the reference itself. */
export async function issueInvoice(args: {
  account: `0x${string}`;
  debtor: `0x${string}`;
  faceValueHuman: string;
  dueDate: Date;
  docHash: `0x${string}`;
}) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account: args.account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "issue",
    args: [
      args.debtor,
      toFusd(args.faceValueHuman),
      BigInt(Math.floor(args.dueDate.getTime() / 1000)),
      args.docHash,
    ],
  });
}

/**
 * Accept a bid. `arkivBidKey` is the Arkiv entity key of the offer being
 * filled, recorded on-chain so a judge (or an auditor) can reconcile the trade
 * against the expiring off-chain bid that produced it. This is the seam between
 * the two systems, made verifiable.
 */
export async function acceptBid(args: {
  account: `0x${string}`;
  id: bigint;
  buyer: `0x${string}`;
  priceHuman: string;
  arkivBidKey: `0x${string}`;
}) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account: args.account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "sell",
    args: [args.id, args.buyer, toFusd(args.priceHuman), args.arkivBidKey],
  });
}

export async function approveFusd(account: `0x${string}`, amountHuman: string) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account,
    address: FUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CLAIM_ADDRESS, toFusd(amountHuman)],
  });
}

export async function settleInvoice(account: `0x${string}`, id: bigint) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "settle",
    args: [id],
  });
}

export const explorerTx = (hash: string) => `https://testnet.snowtrace.io/tx/${hash}`;
export const explorerAddr = (a: string) => `https://testnet.snowtrace.io/address/${a}`;

/** An Arkiv entity key is already 32 bytes; if a future SDK version returns a
 *  different width, hash it so it still fits bytes32 on-chain. */
export function toBytes32(key: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (hex.length === 64) return `0x${hex}` as `0x${string}`;
  throw new Error(
    `Arkiv entity key is ${hex.length / 2} bytes, not 32. Hash it with keccak256 before passing to sell().`,
  );
}
