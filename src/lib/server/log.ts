/** One JSON line per event, so Vercel logs can be filtered and aggregated (see the pre-deploy hardening spec, D5). */
export function logEvent(evt: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt, at: new Date().toISOString(), ...data }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
