/**
 * Reading entities back correctly.
 *
 * Two things about the read shape are easy to get wrong, and both bit this
 * codebase before it was checked against the API reference:
 *
 * 1. SYSTEM FIELDS ARE TOP-LEVEL, NOT IN `attributes`.
 *    The `Entity` class exposes `key`, `owner`, `creator`, `expiresAt`,
 *    `createdAt`, `updatedAt`, `contentType` and `payload` as its own
 *    properties. `attributes` holds ONLY the user attributes. So
 *    `entity.attributes.$expiresAt` is always `undefined` — the value you want
 *    is `entity.expiresAt`, and it is a `bigint` block height.
 *
 *    You still FILTER on `$expiresAt` in a query (`gt("$expiresAt", u64(n))`);
 *    you just don't READ it from `attributes`. The asymmetry is the trap.
 *
 * 2. ATTRIBUTE VALUES COME BACK TAGGED, NOT BARE.
 *    `Attributes = Readonly<Record<string, AnyArkivValue>>`, and e.g.
 *    `U256Value = Value<"u256", bigint>`. So `attributes.invoiceId` is a
 *    tagged wrapper, not a `bigint`. The docs put it nicely: "a value read
 *    from here drops straight back into an AttributeInputs — the vocabulary is
 *    the same in both directions." Convenient for round-tripping, surprising
 *    if you expected a primitive.
 *
 * `unwrap` below tolerates both shapes so it cannot silently return an object
 * where a number was expected.
 */

/** Pull the primitive out of a tagged Arkiv value. Passes bare values through. */
export function unwrap<T = unknown>(v: any): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object" && !Array.isArray(v) && "value" in v) return v.value as T;
  return v as T;
}

export const asString = (v: any, fallback = ""): string => {
  const u = unwrap(v);
  return u === undefined ? fallback : String(u);
};

export const asBigInt = (v: any, fallback = 0n): bigint => {
  const u = unwrap(v);
  if (u === undefined) return fallback;
  return typeof u === "bigint" ? u : BigInt(String(u));
};

export const asNumber = (v: any, fallback = 0): number => {
  const u = unwrap(v);
  if (u === undefined) return fallback;
  return typeof u === "number" ? u : Number(u);
};

export const asBool = (v: any, fallback = false): boolean => {
  const u = unwrap(v);
  return u === undefined ? fallback : Boolean(u);
};

export const asAddress = (v: any): `0x${string}` =>
  (asString(v, "0x0000000000000000000000000000000000000000") as `0x${string}`);

/**
 * A `dec` attribute is a fixed-point decimal. Read it as a string so no
 * precision is lost on the way to the UI — never as a JS number.
 */
export const asDecimalString = (v: any, fallback = "0"): string => asString(v, fallback);

/** System fields, read from where they actually live. */
export interface EntityMeta {
  key: `0x${string}`;
  owner?: `0x${string}`;
  creator?: `0x${string}`;
  /** Block height the entity expires at. Top-level, NOT in `attributes`. */
  expiresAt: bigint;
  createdAt?: bigint;
  updatedAt?: bigint;
}

export function meta(entity: any): EntityMeta {
  return {
    key: entity.key,
    owner: entity.owner,
    creator: entity.creator,
    expiresAt: typeof entity.expiresAt === "bigint" ? entity.expiresAt : 0n,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

/** Blocks remaining until expiry, floored at zero. */
export function blocksLeft(entity: any, nowBlock: bigint): bigint {
  const m = meta(entity);
  if (m.expiresAt === 0n) return 0n;
  const d = m.expiresAt - nowBlock;
  return d > 0n ? d : 0n;
}
