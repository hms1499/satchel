import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

process.env.PROVIDER_SEED ??= "test-provider-seed-0123456789abcdef0123456789";

const { createChallenge, checkChallenge, signChallengeBody, requestDigest } = await import("./x402");

const RESOURCE = "/api/tools/crypto-price";
const PAY_TO = "bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h";

describe("checkChallenge", () => {
  let challenge: ReturnType<typeof createChallenge>;
  beforeAll(() => {
    challenge = createChallenge(RESOURCE, PAY_TO, 1_000n, "aa".repeat(32));
  });

  it("accepts the challenge exactly as the 402 response serves it (with the extra `scheme` field)", () => {
    // Regression: the tool route spreads `{ scheme: "bch-sc402", ...challenge }` into `accepts`, and clients echo it back.
    const served = { scheme: "bch-sc402", ...challenge };
    expect(checkChallenge(served, RESOURCE)).toBeNull();
  });

  it("accepts the bare challenge", () => {
    expect(checkChallenge(challenge, RESOURCE)).toBeNull();
  });

  it("rejects a tampered amount", () => {
    expect(checkChallenge({ ...challenge, amount: "1" }, RESOURCE)).toBe("invalid challenge signature");
  });

  it("rejects a tampered payTo", () => {
    expect(checkChallenge({ ...challenge, payTo: "bchtest:qqattacker" }, RESOURCE)).toBe("invalid challenge signature");
  });

  it("rejects a tampered request binding", () => {
    expect(checkChallenge({ ...challenge, request: "bb".repeat(32) }, RESOURCE)).toBe("invalid challenge signature");
  });

  it("rejects a challenge issued for another resource", () => {
    expect(checkChallenge(challenge, "/api/tools/deep-analysis")).toBe("challenge is for a different resource");
  });

  it("rejects an expired challenge", () => {
    const old = { ...challenge, expires: Date.now() - 1 };
    // Expiry is covered by the signature, so an honest-but-old challenge must be re-signed to test it.
    const resigned = { ...old, sig: signChallengeBody(old) };
    expect(checkChallenge(resigned, RESOURCE)).toBe("challenge expired");
  });
});

describe("402 body", () => {
  it("402 body is byte-compatible with 0.1.0 clients", async () => {
    const { createPaywall } = await import("../../../provider-kit/src/index");
    const { parseChallenge } = await import("../x402-client");
    const { NETWORK } = await import("../config");
    const pay = createPaywall({
      network: NETWORK,
      secret: process.env.PROVIDER_SEED!,
      getTransaction: async () => {
        throw new Error("not called without X-Payment");
      },
    });
    const req = new Request("http://localhost/api/tools/crypto-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bitcoin-cash" }),
    });
    const route = { resource: RESOURCE, name: "crypto-price", price: 1_000n, payTo: PAY_TO, params: ["id"], handler: async () => ({}) };
    const res = await pay.handle(req, route);

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBe('BCH-SC402 realm="satchel"');
    const body = await res.json();
    // The 0.1.0 route's exact shape and field order: { error, accepts: [{ scheme, ...challenge }] }.
    expect(Object.keys(body)).toEqual(["error", "accepts"]);
    expect(body.error).toBe("payment required");
    expect(Object.keys(body.accepts[0])).toEqual(["scheme", "resource", "payTo", "amount", "nonce", "expires", "network", "request", "sig"]);

    const parsed = parseChallenge(body, NETWORK);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.challenge).toMatchObject({ resource: RESOURCE, payTo: PAY_TO, amount: "1000", network: NETWORK });
    // The app's wrappers accept it, bound to the same request digest as the 0.1.0 route.
    expect(checkChallenge(parsed.challenge, RESOURCE, requestDigest("crypto-price", { id: "bitcoin-cash" }))).toBeNull();
    // Same HMAC as the 0.1.0 server (node:crypto under PROVIDER_SEED), so challenges issued before the upgrade still verify.
    const { resource, payTo, amount, nonce, expires, network, request } = parsed.challenge;
    const legacySig = createHmac("sha256", process.env.PROVIDER_SEED!)
      .update(JSON.stringify({ resource, payTo, amount, nonce, expires, network, request }))
      .digest("hex");
    expect(parsed.challenge.sig).toBe(legacySig);
  });
});
