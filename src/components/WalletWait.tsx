"use client";

import { useEffect, useState } from "react";

/** Shown while a wallet approval is pending: where to look, and how long it has been. Give it a `key` per step to restart the count. */
export function WalletWait({ active }: { active: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;
  return (
    <p role="status" className="text-[13px] text-muted">
      Open your wallet app (for example Cashonize) to review and approve. This can take up to a minute.{" "}
      <span className="font-mono tabular-nums">{seconds}s</span>
    </p>
  );
}
