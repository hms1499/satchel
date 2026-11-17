import { AgentAuthError, openDescriptor, vaultStatus } from "@/lib/server/agent-wallet";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const opened = openDescriptor(body.descriptor, { requireToken: false });
    return Response.json(await vaultStatus(opened));
  } catch (e) {
    const status = e instanceof AgentAuthError ? 400 : 502;
    return Response.json({ error: e instanceof Error ? e.message : "status failed" }, { status });
  }
}
