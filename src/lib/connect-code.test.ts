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
});
