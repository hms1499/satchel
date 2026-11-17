import { describe, it, expect } from "vitest";
import { decodeConnectCode, encodeConnectCode, type ConnectInfo } from "./connect-code";

const info: ConnectInfo = {
  v: 1,
  network: "mainnet",
  params: {
    ownerPk: "02" + "11".repeat(32),
    agentPk: "03" + "22".repeat(32),
    capPerPeriod: "8000",
    periodBlocks: "144",
    allowlist: ["bitcoincash:qzhw4v5cag3h98392ktmmaean9wysfmdvuuafy2net"],
  },
  genesisTxid: "ab".repeat(32),
};

describe("connect code", () => {
  it("round-trips", () => {
    const code = encodeConnectCode(info);
    expect(code.startsWith("satchel1:")).toBe(true);
    expect(code).not.toMatch(/[+/=]/); // base64url, no padding
    expect(decodeConnectCode(code)).toEqual({ ok: true, info });
  });

  it("survives being wrapped in backticks, quotes and newlines", () => {
    const code = encodeConnectCode(info);
    expect(decodeConnectCode(`\n  \`${code}\`\n`)).toEqual({ ok: true, info });
    expect(decodeConnectCode(`"${code}"`)).toEqual({ ok: true, info });
  });

  it("refuses another prefix", () => {
    const code = encodeConnectCode(info).replace("satchel1:", "satchel2:");
    expect(decodeConnectCode(code)).toEqual({ ok: false, error: "not a Satchel connect code" });
  });

  it("refuses a truncated payload", () => {
    const code = encodeConnectCode(info);
    expect(decodeConnectCode(code.slice(0, code.length - 12))).toEqual({ ok: false, error: "malformed connect code" });
  });

  it("never carries an access token, even if a descriptor with one is passed in", () => {
    const withToken = { ...info, token: "cd".repeat(32), agentIndex: 5 } as unknown as ConnectInfo;
    const decoded = decodeConnectCode(encodeConnectCode(withToken));
    expect(decoded.ok).toBe(true);
    expect(JSON.stringify(decoded)).not.toContain("cd".repeat(32));
  });

  it("round-trips labels and seller origins", () => {
    const withMeta: ConnectInfo = {
      ...info,
      labels: { "bitcoincash:qzhw4v5cag3h98392ktmmaean9wysfmdvuuafy2net": "Alice" },
      sellers: ["https://satchel-sigma.vercel.app"],
    };
    expect(decodeConnectCode(encodeConnectCode(withMeta))).toEqual({ ok: true, info: withMeta });
  });

  it("a code from 0.1.0 without labels still decodes", () => {
    // Literal output of encodeConnectCode(info) before labels/sellers existed.
    const legacy =
      "satchel1:eyJ2IjoxLCJuZXR3b3JrIjoibWFpbm5ldCIsInBhcmFtcyI6eyJvd25lclBrIjoiMDIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwiYWdlbnRQayI6IjAzMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMiIsImNhcFBlclBlcmlvZCI6IjgwMDAiLCJwZXJpb2RCbG9ja3MiOiIxNDQiLCJhbGxvd2xpc3QiOlsiYml0Y29pbmNhc2g6cXpodzR2NWNhZzNoOTgzOTJrdG1tYWVhbjl3eXNmbWR2dXVhZnkybmV0Il19LCJnZW5lc2lzVHhpZCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIifQ";
    expect(decodeConnectCode(legacy)).toEqual({ ok: true, info });
  });

  it("drops unknown fields", () => {
    const code = encodeConnectCode({ ...info, token: "ff".repeat(32) } as ConnectInfo);
    const res = decodeConnectCode(code);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain("token");
  });
});
