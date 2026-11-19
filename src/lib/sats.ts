/** A form value as a whole number of sats, or null (decimals, exponents, signs, empty): never throws like BigInt(). */
export function parseWholeSats(input: string): bigint | null {
  const v = input.trim();
  return /^\d+$/.test(v) ? BigInt(v) : null;
}
