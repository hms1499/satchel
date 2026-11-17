import { z } from "zod";
import { DescriptorSchema } from "./descriptor";

/**
 * A connect code hands a vault's public settings from the web app to the user's own agent (satchel-pay-mcp):
 * "satchel1:" + base64url(JSON). It contains no secret: everything in it is public on chain once the vault exists.
 */
const PREFIX = "satchel1:";

const ConnectInfoSchema = z.object({
  v: z.literal(1),
  network: z.enum(["mainnet", "chipnet"]),
  params: DescriptorSchema.shape.params,
  genesisTxid: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  labels: DescriptorSchema.shape.labels,
  sellers: DescriptorSchema.shape.sellers,
});

export type ConnectInfo = z.infer<typeof ConnectInfoSchema>;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64: string): string {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeConnectCode(info: ConnectInfo): string {
  // Copy only the public fields, so nothing else (e.g. an access token) can leak into the code.
  const { v, network, params, genesisTxid, labels, sellers } = info;
  const { ownerPk, agentPk, capPerPeriod, periodBlocks, allowlist } = params;
  return PREFIX + toBase64Url(JSON.stringify({ v, network, params: { ownerPk, agentPk, capPerPeriod, periodBlocks, allowlist }, genesisTxid, labels, sellers }));
}

export function decodeConnectCode(code: string): { ok: true; info: ConnectInfo } | { ok: false; error: string } {
  const trimmed = code.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (!trimmed.startsWith(PREFIX)) return { ok: false, error: "not a Satchel connect code" };
  try {
    const parsed = ConnectInfoSchema.safeParse(JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length))));
    return parsed.success ? { ok: true, info: parsed.data } : { ok: false, error: "malformed connect code" };
  } catch {
    return { ok: false, error: "malformed connect code" };
  }
}
