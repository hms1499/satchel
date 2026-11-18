import { describe, expect, it } from "vitest";
import { encodeCashAddress } from "@bitauth/libauth";
import { InputError } from "satchel-pay-server";
import { decodeAddress, decodeScript } from "./decoder.js";

// Well-known mainnet P2PKH vector (libauth / cashaddr spec).
const LEGACY = "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu";
const CASHADDR = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const TOKEN_AWARE = "bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwvrqekrq9w";
const P2SH32 = encodeCashAddress({ prefix: "bitcoincash", type: "p2sh", payload: new Uint8Array(32).fill(7) }).address;

describe("decodeAddress", () => {
  it("decodes a mainnet P2PKH to its legacy form", () => {
    const r = decodeAddress(CASHADDR);
    expect(r.type).toBe("p2pkh");
    expect(r.network).toBe("mainnet");
    expect(r.forms.legacy).toBe(LEGACY);
    expect(r.forms.cashaddr).toBe(CASHADDR);
    expect(r.forms.tokenAware).toBe(TOKEN_AWARE);
    expect(r.lockingBytecode).toBe("76a914" + "76a04053bda0a88bda5177b86a15c3b29f559873" + "88ac");
  });

  it("gives the same cashaddr for a token-aware z... input", () => {
    expect(decodeAddress(TOKEN_AWARE).forms.cashaddr).toBe(CASHADDR);
  });

  it("returns legacy: null for a P2SH32", () => {
    const r = decodeAddress(P2SH32);
    expect(r.type).toBe("p2sh32");
    expect(r.forms.legacy).toBeNull();
  });

  it("detects chipnet", () => {
    expect(decodeAddress("bchtest:qz509yk0wh4egyh63jyu0uu4kljp0ngauure7y5xe2").network).toBe("chipnet");
  });

  it("rejects garbage with an InputError", () => {
    expect(() => decodeAddress("zz")).toThrow(InputError);
    expect(() => decodeAddress("")).toThrow(InputError);
  });
});

describe("decodeScript", () => {
  it("decodes OP_RETURN text", () => {
    const r = decodeScript("6a0453415443");
    expect(r.type).toBe("op_return");
    expect(r.asm).toBe("OP_RETURN OP_PUSHBYTES_4 0x53415443");
    expect(r.opReturn).toEqual([{ hex: "53415443", text: "SATC" }]);
  });

  it("gives text null for non-UTF-8 pushes", () => {
    expect(decodeScript("6a02fffe").opReturn).toEqual([{ hex: "fffe", text: null }]);
  });

  it("classifies a P2PKH script", () => {
    const r = decodeScript("76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac");
    expect(r.type).toBe("p2pkh");
    expect(r.opReturn).toBeNull();
    expect(r.asm).toContain("OP_DUP OP_HASH160");
  });

  it("calls anything else nonstandard", () => {
    expect(decodeScript("51").type).toBe("nonstandard");
  });

  it("rejects non-hex, odd-length, empty and oversized input", () => {
    expect(() => decodeScript("zz")).toThrow(InputError);
    expect(() => decodeScript("abc")).toThrow(InputError);
    expect(() => decodeScript("")).toThrow(InputError);
    expect(() => decodeScript("00".repeat(10001))).toThrow(InputError);
  });
});
