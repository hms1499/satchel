import { NETWORK } from "@/lib/config";
import { EST_FEE_PER_CALL, PAID_TOOLS, TOOL_NAMES } from "@/lib/tools";
import { providerKeys } from "@/lib/server/keys";
import { hasLlm } from "@/lib/server/llm";
import { loadSellers } from "@/lib/server/sellers";

// Parsed once when the server loads this route: a malformed SATCHEL_SELLERS fails loudly instead of hiding sellers.
const SELLERS = loadSellers();

export async function GET() {
  const providers = providerKeys();
  return Response.json({
    network: NETWORK,
    llm: hasLlm(),
    feePerCall: EST_FEE_PER_CALL.toString(),
    tools: TOOL_NAMES.map((name) => ({
      name,
      title: PAID_TOOLS[name].title,
      description: PAID_TOOLS[name].description,
      price: PAID_TOOLS[name].price.toString(),
      params: PAID_TOOLS[name].params,
      payTo: providers[PAID_TOOLS[name].provider].address,
    })),
    sellers: SELLERS,
  });
}
