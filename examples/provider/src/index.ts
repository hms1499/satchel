import { Hono } from "hono";
import {
  createPaywall,
  InputError,
  wellKnownResponse,
  type BchNetwork,
  type CatalogEntry,
  type PaidRoute,
} from "satchel-pay-server";
import { decodeAddress, decodeScript } from "./decoder";

const network: BchNetwork = (process.env.SELLER_NETWORK ?? "mainnet") === "chipnet" ? "chipnet" : "mainnet";
const payTo = process.env.SELLER_PAY_TO ?? "";
// createPaywall throws unless SELLER_SECRET is a string of at least 32 characters.
const pay = createPaywall({ network, secret: process.env.SELLER_SECRET as string, log: (e) => console.log(JSON.stringify(e)) });

const PRICE = 500n;

const addressRoute: PaidRoute = {
  resource: "/api/address",
  name: "bch-address-decode",
  price: PRICE,
  payTo,
  params: ["address"],
  validate: (p) => {
    decodeAddress(p.get("address") ?? "");
  },
  handler: async (p) => decodeAddress(p.get("address") ?? ""),
};

const scriptRoute: PaidRoute = {
  resource: "/api/script",
  name: "bch-script-decode",
  price: PRICE,
  payTo,
  params: ["hex"],
  validate: (p) => {
    decodeScript(p.get("hex") ?? "");
  },
  handler: async (p) => decodeScript(p.get("hex") ?? ""),
};

const app = new Hono();

app.on(["POST"], "/api/address", (c) => pay.handle(c.req.raw, addressRoute));
app.on(["POST"], "/api/script", (c) => pay.handle(c.req.raw, scriptRoute));

app.get("/.well-known/satchel.json", (c) => {
  const origin = new URL(c.req.url).origin;
  const tools: CatalogEntry[] = [
    {
      name: addressRoute.name,
      title: "CashAddr decoder",
      description: "Decode a Bitcoin Cash address: all address forms (CashAddr, token-aware, legacy), type, network and locking bytecode.",
      price: PRICE.toString(),
      params: { address: "a CashAddr to decode (bitcoincash: or bchtest:, plain or token-aware)" },
      payTo,
      endpoint: `${origin}${addressRoute.resource}`,
    },
    {
      name: scriptRoute.name,
      title: "Script decoder",
      description: "Disassemble a Bitcoin Cash locking script given as hex: opcodes, script type and OP_RETURN text.",
      price: PRICE.toString(),
      params: { hex: "a script as hex (at most 10000 bytes)" },
      payTo,
      endpoint: `${origin}${scriptRoute.resource}`,
    },
  ];
  return wellKnownResponse({ name: "Satchel example seller: BCH decoder", network, tools });
});

app.get("/", (c) =>
  c.text(
    [
      "Satchel example seller: a Bitcoin Cash address and script decoder, paid per call (500 sats) over HTTP 402.",
      "",
      "POST /api/address  {\"address\": \"...\"}",
      "POST /api/script   {\"hex\": \"...\"}",
      "GET  /.well-known/satchel.json  (tool catalog)",
      "",
      "Protocol (bch-sc402) and seller kit: https://github.com/hms1499/satchel",
      "",
    ].join("\n"),
  ),
);

app.onError((err, c) => {
  if (err instanceof InputError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
