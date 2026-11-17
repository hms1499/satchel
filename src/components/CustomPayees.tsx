"use client";

import { Button } from "./ui";

export interface PayeeRow {
  id: number;
  label: string;
  address: string;
}

let nextRowId = 0;
export const newPayeeRow = (): PayeeRow => ({ id: nextRowId++, label: "", address: "" });

/** Editable rows of label + address: any BCH address the agent may pay besides the tools and sellers. */
export function CustomPayees({ rows, onChange, field }: { rows: PayeeRow[]; onChange: (rows: PayeeRow[]) => void; field: string }) {
  const update = (id: number, patch: Partial<PayeeRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1 text-sm font-semibold">Custom payees</legend>
      <p className="text-[13px] text-muted">
        Any other BCH address the agent may pay, such as a person or a shop. Labels stay in your browser and the connect code;
        only the address goes on chain.
      </p>
      {rows.map((r, i) => (
        <div key={r.id} className="flex flex-wrap items-end gap-2.5 rounded-xl border border-line p-3">
          <label className="flex min-w-0 flex-[1_1_140px] flex-col gap-1 text-[13px] font-semibold">
            Label
            <input
              className={`${field} font-sans`}
              value={r.label}
              maxLength={32}
              placeholder="e.g. Alice"
              aria-label={`Custom payee ${i + 1} label`}
              onChange={(e) => update(r.id, { label: e.target.value })}
            />
          </label>
          <label className="flex min-w-0 flex-[3_1_260px] flex-col gap-1 text-[13px] font-semibold">
            Address
            <input
              className={`${field} text-[13px]`}
              value={r.address}
              spellCheck={false}
              autoComplete="off"
              placeholder="bitcoincash:… or bchtest:…"
              aria-label={`Custom payee ${i + 1} address`}
              onChange={(e) => update(r.id, { address: e.target.value })}
            />
          </label>
          <Button variant="secondary" onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
            Remove
          </Button>
        </div>
      ))}
      <Button variant="secondary" className="self-start" onClick={() => onChange([...rows, newPayeeRow()])}>
        Add payee
      </Button>
    </fieldset>
  );
}
