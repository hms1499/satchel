import { NETWORK } from "@/lib/config";
import { EST_FEE_PER_CALL, PAID_TOOLS, TOOL_NAMES } from "@/lib/tools";
import { providerKeys } from "@/lib/server/keys";
import { hasLlm } from "@/lib/server/llm";

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
      payTo: providers[PAID_TOOLS[name].provider].address,
    })),
  });
}
