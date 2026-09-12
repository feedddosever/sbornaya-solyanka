/**
 * The project attribute.
 *
 * Arkiv's best-practices guide opens with this, and it is not a style
 * preference — it is a correctness requirement:
 *
 *   "All entities in Arkiv are public and stored in a shared database. Every
 *    project MUST define a unique project attribute and include it on every
 *    entity. Without a project attribute, your queries can return data from
 *    other projects, and other projects can see yours."
 *
 * That matters acutely at a hackathon: forty builders are writing to the same
 * Tiramisu testnet this weekend. A query filtered only on `kind = str('bid')`
 * would happily return another team's bids, and Factor's market would fill
 * with strangers' rows. The fix is one attribute on every write and one clause
 * on every read.
 *
 * The value must be globally unique. `factor` alone is not — it is a common
 * English word and a plausible name for someone else's project.
 */
export const PROJECT = {
  key: "project",
  value: "factor-invoice-market-ethrome-2026",
} as const;

/**
 * Attribute-name rules this satisfies, for the record: `project` is <=32 bytes,
 * matches /^[A-Za-z][A-Za-z0-9._-]*$/, has no leading `$`, contains no `--`
 * (which would open a comment in the query language), and is not a reserved
 * word.
 */
export const PROJECT_KEY = PROJECT.key;
export const PROJECT_VALUE = PROJECT.value;
