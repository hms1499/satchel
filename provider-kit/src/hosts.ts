import type { BchNetwork } from "./protocol";

/**
 * Fulcrum servers, in order: CashScript's default first, then independent operators (verified reachable with
 * listunspent support on 2026-11-19). Used for failover by satchel-pay-server and by Satchel's app and MCP server.
 */
export const ELECTRUM_HOSTS: Record<BchNetwork, readonly string[]> = {
  mainnet: ["bch.imaginary.cash", "bch.loping.net", "fulcrum.greyh.at"],
  chipnet: ["chipnet.bch.ninja", "chipnet.imaginary.cash"],
};

/** Node verdicts (a rejected transaction, an unknown txid): answers, never a reason to try another server. */
const NODE_VERDICT = /mandatory-script-verify|non-BIP68-final|missing-?inputs|txn-mempool-conflict|dust|bad-txns|no such mempool|not found/i;
const CONNECTION = /timed? ?out|establish connection|failed to connect|ECONN|ENOTFOUND|EAI_AGAIN|connection (closed|lost|refused)|socket|websocket|disconnected|not connected/i;

/** True for a failure to reach the server (timeout, refused, dropped socket); false for anything the node answered. */
export function isConnectionError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return !NODE_VERDICT.test(message) && CONNECTION.test(message);
}
