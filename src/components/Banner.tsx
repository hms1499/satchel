import { BANNER } from "@/lib/config";

/** Required by BCH BLAZE rules: slides, source code and an EMBER2026 donation address at the top of the page. */
export function Banner() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 bg-ink px-4 py-2 text-[13px] text-[#e8ecE6]">
      <span className="font-semibold text-white">BCH BLAZE 2026 entry</span>
      <a className="text-[#7fe3c2] underline-offset-2 hover:underline" href={BANNER.slides} target="_blank" rel="noreferrer">
        Project slides
      </a>
      <a className="text-[#7fe3c2] underline-offset-2 hover:underline" href={BANNER.repo} target="_blank" rel="noreferrer">
        Source code
      </a>
      <span className="min-w-0 break-all">
        Donate EMBER2026: <span className="font-mono text-white">{BANNER.emberAddress || "[address coming soon]"}</span>
      </span>
    </div>
  );
}
