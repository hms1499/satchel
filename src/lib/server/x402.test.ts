import { describe, it, expect, beforeAll } from "vitest";

process.env.PROVIDER_SEED ??= "test-provider-seed-0123456789abcdef0123456789";

const { createChallenge, checkChallenge, signChallengeBody } = await import("./x402");

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
