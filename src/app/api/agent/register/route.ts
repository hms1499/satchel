import { randomInt } from "node:crypto";
import { accessToken, agentKey } from "@/lib/server/keys";

/** Creates a fresh agent identity for a new vault. Stateless: the key is re-derived from the index. */
export async function POST() {
  const agentIndex = randomInt(0, 2 ** 31 - 1);
  const key = agentKey(agentIndex);
  return Response.json({ agentIndex, agentPk: key.pubHex, token: accessToken(agentIndex) });
}
