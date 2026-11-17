import { AgentAuthError, demoAttackerAddress, openDescriptor, payFromVault, vaultStatus } from "@/lib/server/agent-wallet";

/**
 * "Try to break it": the server signs covenant-violating transactions with the real agent key and
 * broadcasts them. The network rejects them; we return the node error and the failing covenant rule.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const opened = openDescriptor(body.descriptor);
    const kind = body.kind === "attacker" ? "attacker" : "overspend";
    const status = await vaultStatus(opened);
    const balance = BigInt(status.balance);
    if (balance === 0n) return Response.json({ error: "Vault not found or already closed" }, { status: 400 });

    let outcome;
    if (kind === "overspend") {
      // One payment larger than the whole period cap, to an allowlisted payee.
      const amount = opened.params.capPerPeriod + 1_000n;
      if (balance < amount + 3_000n) return Response.json({ error: "Vault balance is below the cap; deposit more to demo an overspend" }, { status: 400 });
      outcome = await payFromVault(opened, opened.params.allowlist[0], amount);
    } else {
      // A small payment to an address that is not in the allowlist (pretending it is entry 0).
      outcome = await payFromVault(opened, demoAttackerAddress(), 1_000n, undefined, { overrideRecipientIndex: 0 });
    }
    if (outcome.ok) {
      // Should be impossible; surface loudly if the covenant ever lets this through.
      return Response.json({ error: "UNEXPECTED: the attack transaction was accepted", txid: outcome.txid }, { status: 500 });
    }
    if (!outcome.covenant) {
      // Not a covenant verdict (busy vault, network error): don't present it as proof.
      return Response.json({ error: `The test could not run: ${outcome.reason}` }, { status: 503 });
    }
    return Response.json({ kind, rejected: true, reason: outcome.reason, rule: outcome.rule, nodeError: outcome.nodeError });
  } catch (e) {
    const status = e instanceof AgentAuthError ? 400 : 502;
    return Response.json({ error: e instanceof Error ? e.message : "attack failed" }, { status });
  }
}
