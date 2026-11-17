import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NodeLikeProvider } from "../../src/lib/test-utils/node-like-provider";
import { VaultSpender } from "../../src/lib/spend";
import { loadConfig } from "./config";
import { createHandlers } from "./tools";
import { createSatchelServer } from "./server";

async function connectedClient() {
  const cfg = loadConfig({ SATCHEL_HOME: join(mkdtempSync(join(tmpdir(), "satchel-srv-")), "home"), SATCHEL_URL: "https://satchel.test" });
  const handlers = createHandlers({ cfg, provider: new NodeLikeProvider(), fetch, spender: new VaultSpender() });
  const server = createSatchelServer(handlers);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("satchel-pay-mcp server", () => {
  it("lists exactly the six Satchel tools, each with a description", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["satchel_catalog", "satchel_connect", "satchel_pay_fetch", "satchel_send", "satchel_setup", "satchel_status"]);
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20);
    expect(tools.find((t) => t.name === "satchel_pay_fetch")?.description).toMatch(/real BCH/);
  });

  it("satchel_setup returns the agent public key", async () => {
    const client = await connectedClient();
    const r = (await client.callTool({ name: "satchel_setup", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0].text).agentPk).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it("satchel_send says it pays only allowlisted payees within the cap, and rejects a dust amount", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "satchel_send")?.description).toMatch(/allowlisted payees/);
    const r = (await client.callTool({ name: "satchel_send", arguments: { to: "bitcoincash:qq", amountSats: 545 } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it("validates tool input (satchel_pay_fetch needs a url)", async () => {
    const client = await connectedClient();
    const r = (await client.callTool({ name: "satchel_pay_fetch", arguments: {} })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});
