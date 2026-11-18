import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { checkChallenge, createChallenge, requestDigest, signChallengeBody } from "./challenge";
import type { Challenge } from "./protocol";

const SECRET = "test-provider-seed-0123456789abcdef0123456789";
const RESOURCE = "/api/tools/crypto-price";
const PAY_TO = "bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h";

const issue = (o: Partial<Parameters<typeof createChallenge>[0]> = {}) =>
  createChallenge({ resource: RESOURCE, payTo: PAY_TO, amount: 1_000n, request: "aa".repeat(32), network: "chipnet", secret: SECRET, ...o });

describe("checkChallenge", () => {
  let challenge: Challenge;
  beforeAll(() => {
    challenge = issue();
  });

  it("accepts the challenge exactly as the 402 response serves it (with the extra `scheme` field)", () => {
    // Regression: the 402 body spreads `{ scheme: "bch-sc402", ...challenge }` into `accepts`, and clients echo it back.
    const served = { scheme: "bch-sc402", ...challenge };
    expect(checkChallenge(served, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBeNull();
  });

  it("accepts the bare challenge", () => {
    expect(checkChallenge(challenge, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBeNull();
  });

  it("rejects a missing challenge", () => {
    expect(checkChallenge(undefined, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe("invalid challenge signature");
  });

  it("rejects a challenge signed with another secret", () => {
    expect(checkChallenge(challenge, { resource: RESOURCE, network: "chipnet", secret: SECRET + "x" })).toBe("invalid challenge signature");
  });

  it("rejects a tampered amount", () => {
    expect(checkChallenge({ ...challenge, amount: "1" }, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe("invalid challenge signature");
  });

  it("rejects a tampered payTo", () => {
    expect(checkChallenge({ ...challenge, payTo: "bchtest:qqattacker" }, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe(
      "invalid challenge signature",
    );
  });

  it("rejects a tampered request binding", () => {
    expect(checkChallenge({ ...challenge, request: "bb".repeat(32) }, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe(
      "invalid challenge signature",
    );
  });

  it("rejects a challenge issued for another resource", () => {
    expect(checkChallenge(challenge, { resource: "/api/tools/deep-analysis", network: "chipnet", secret: SECRET })).toBe("challenge is for a different resource");
  });

  it("rejects a payment for a different request", () => {
    expect(checkChallenge(challenge, { resource: RESOURCE, request: "cc".repeat(32), network: "chipnet", secret: SECRET })).toBe(
      "payment is for a different request",
    );
  });

  it("rejects an expired challenge", () => {
    const old = { ...challenge, expires: Date.now() - 1 };
    // Expiry is covered by the signature, so an honest-but-old challenge must be re-signed to test it.
    const resigned = { ...old, sig: signChallengeBody(old, SECRET) };
    expect(checkChallenge(resigned, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe("challenge expired");
  });

  it("rejects a challenge issued for another network", () => {
    const other = issue({ network: "mainnet" });
    expect(checkChallenge(other, { resource: RESOURCE, network: "chipnet", secret: SECRET })).toBe("challenge is for another network");
    expect(checkChallenge(other, { resource: RESOURCE, network: "mainnet", secret: SECRET })).toBeNull();
  });

  it("rejects signatures of the wrong length or case without throwing", () => {
    const o = { resource: RESOURCE, network: "chipnet" as const, secret: SECRET };
    expect(checkChallenge({ ...challenge, sig: challenge.sig.slice(0, -1) }, o)).toBe("invalid challenge signature");
    expect(checkChallenge({ ...challenge, sig: challenge.sig + "00" }, o)).toBe("invalid challenge signature");
    expect(checkChallenge({ ...challenge, sig: challenge.sig.toUpperCase() }, o)).toBe("invalid challenge signature");
  });

  it("uses the injected clock for expiry", () => {
    const c = issue({ now: 1_000, ttlMs: 50 });
    expect(c.expires).toBe(1_050);
    expect(checkChallenge(c, { resource: RESOURCE, network: "chipnet", secret: SECRET, now: 1_050 })).toBeNull();
    expect(checkChallenge(c, { resource: RESOURCE, network: "chipnet", secret: SECRET, now: 1_051 })).toBe("challenge expired");
  });
});

describe("createChallenge", () => {
  it("fills the wire fields: decimal amount, 16-byte hex nonce, 10 minute expiry, network and request", () => {
    const c = issue({ now: 5_000 });
    expect(c).toMatchObject({ resource: RESOURCE, payTo: PAY_TO, amount: "1000", expires: 5_000 + 600_000, network: "chipnet", request: "aa".repeat(32) });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(c.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(issue().nonce).not.toBe(c.nonce);
  });
});

describe("signChallengeBody", () => {
  it("signature equals node:crypto createHmac output", () => {
    const c = issue();
    const { resource, payTo, amount, nonce, expires, network, request } = c;
    const expected = createHmac("sha256", SECRET)
      .update(JSON.stringify({ resource, payTo, amount, nonce, expires, network, request }))
      .digest("hex");
    expect(c.sig).toBe(expected);
    expect(signChallengeBody(c, SECRET)).toBe(expected);
  });

  it("ignores extra fields and field order", () => {
    const c = issue();
    const reordered = { scheme: "bch-sc402", sig: c.sig, request: c.request, network: c.network, expires: c.expires, nonce: c.nonce, amount: c.amount, payTo: c.payTo, resource: c.resource };
    expect(signChallengeBody(reordered, SECRET)).toBe(c.sig);
  });
});

describe("requestDigest", () => {
  it("canonicalizes the request (parameter order does not matter)", () => {
    expect(requestDigest("web-reader", { a: "1", b: "2" })).toBe(requestDigest("web-reader", new URLSearchParams("b=2&a=1")));
    expect(requestDigest("web-reader", { a: "1" })).not.toBe(requestDigest("crypto-price", { a: "1" }));
  });

  it("equals today's node:crypto digest of the canonical JSON", () => {
    const canonical = JSON.stringify(["crypto-price", [["id", "bitcoin-cash"], ["vs", "usd"]]]);
    const expected = createHash("sha256").update(canonical).digest("hex");
    expect(requestDigest("crypto-price", new URLSearchParams("vs=usd&id=bitcoin-cash"))).toBe(expected);
  });

  it("hashes non-ASCII parameters as UTF-8", () => {
    const canonical = JSON.stringify(["web-reader", [["q", "Tiếng Việt ✓"]]]);
    expect(requestDigest("web-reader", { q: "Tiếng Việt ✓" })).toBe(createHash("sha256").update(canonical).digest("hex"));
  });
});
