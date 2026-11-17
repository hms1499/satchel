import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ElectrumNetworkProvider } from "../../src/lib/chain-deps";
import { VaultSpender } from "../../src/lib/spend";
import { loadConfig } from "./config";
import { createHandlers } from "./tools";
import { createSatchelServer, VERSION } from "./server";

// stdout carries the MCP protocol only; everything for humans goes to stderr.
async function main() {
  const cfg = loadConfig();
  const provider = new ElectrumNetworkProvider(cfg.network);
  const handlers = createHandlers({ cfg, provider, fetch, spender: new VaultSpender() });
  const server = createSatchelServer(handlers);
  await server.connect(new StdioServerTransport());
  console.error(`satchel-pay-mcp ${VERSION} running on ${cfg.network} (Satchel at ${cfg.satchelUrl}, home ${cfg.home})`);
}

main().catch((e) => {
  console.error(`satchel-pay-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
