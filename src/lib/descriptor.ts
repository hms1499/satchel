import { z } from "zod";
import type { VaultParams } from "./vault";

/**
 * Everything needed to find and operate a vault. Stored client-side (localStorage) and sent to the
 * server with each agent request. It contains no secrets except the agent access token, which only
 * lets the caller ask our agent to spend within the covenant's limits.
 */
/** Agent index recorded for a vault whose agent key is held by the user's own agent (e.g. satchel-pay-mcp). */
export const EXTERNAL_AGENT_INDEX = 0xffffffff;

export const DescriptorSchema = z.object({
  version: z.literal(1),
  network: z.enum(["mainnet", "chipnet"]),
  agentIndex: z.number().int().nonnegative().max(EXTERNAL_AGENT_INDEX),
  // Empty for a vault recovered from chain: the access token is never published, so the agent can't be driven.
  token: z.string().regex(/^([0-9a-f]{64})?$/),
  params: z.object({
    ownerPk: z.string().regex(/^0[23][0-9a-f]{64}$/),
    agentPk: z.string().regex(/^0[23][0-9a-f]{64}$/),
    capPerPeriod: z.string().regex(/^\d+$/),
    periodBlocks: z.string().regex(/^\d+$/),
    allowlist: z.array(z.string().min(10)).min(1).max(8),
  }),
  // Display names for payees, keyed by canonical (non-token) CashAddr.
  labels: z.record(z.string(), z.string().min(1).max(32)).optional(),
  // Origins of third-party sellers this vault's agent may buy from (used by satchel-pay-mcp).
  sellers: z.array(z.string().url()).max(8).optional(),
  createdAt: z.number().optional(),
  genesisTxid: z.string().optional(),
  recovered: z.boolean().optional(),
  // The agent key is held outside Satchel (the user's own agent); Satchel's hosted agent never drives this vault.
  external: z.boolean().optional(),
});

export type VaultDescriptor = z.infer<typeof DescriptorSchema>;

/** VaultParams from the JSON form used in descriptors and connect codes (sats as decimal strings). */
export function paramsFromDescriptorParams(p: VaultDescriptor["params"]): VaultParams {
  return { ...p, capPerPeriod: BigInt(p.capPerPeriod), periodBlocks: BigInt(p.periodBlocks) };
}

export function descriptorParams(d: VaultDescriptor): VaultParams {
  return {
    ownerPk: d.params.ownerPk,
    agentPk: d.params.agentPk,
    capPerPeriod: BigInt(d.params.capPerPeriod),
    periodBlocks: BigInt(d.params.periodBlocks),
    allowlist: d.params.allowlist,
  };
}

export function paramsToDescriptorParams(p: VaultParams): VaultDescriptor["params"] {
  return {
    ownerPk: p.ownerPk,
    agentPk: p.agentPk,
    capPerPeriod: p.capPerPeriod.toString(),
    periodBlocks: p.periodBlocks.toString(),
    allowlist: p.allowlist,
  };
}
