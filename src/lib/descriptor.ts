import { z } from "zod";
import type { VaultParams } from "./vault";

/**
 * Everything needed to find and operate a vault. Stored client-side (localStorage) and sent to the
 * server with each agent request. It contains no secrets except the agent access token, which only
 * lets the caller ask our agent to spend within the covenant's limits.
 */
export const DescriptorSchema = z.object({
  version: z.literal(1),
  network: z.enum(["mainnet", "chipnet"]),
  agentIndex: z.number().int().nonnegative(),
  // Empty for a vault recovered from chain: the access token is never published, so the agent can't be driven.
  token: z.string().regex(/^([0-9a-f]{64})?$/),
  params: z.object({
    ownerPk: z.string().regex(/^0[23][0-9a-f]{64}$/),
    agentPk: z.string().regex(/^0[23][0-9a-f]{64}$/),
    capPerPeriod: z.string().regex(/^\d+$/),
    periodBlocks: z.string().regex(/^\d+$/),
    allowlist: z.array(z.string().min(10)).min(1).max(8),
  }),
  createdAt: z.number().optional(),
  genesisTxid: z.string().optional(),
  recovered: z.boolean().optional(),
});

export type VaultDescriptor = z.infer<typeof DescriptorSchema>;

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
