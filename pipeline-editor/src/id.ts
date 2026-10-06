/**
 * A fresh v4 UUID for a new step or edge id.
 *
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or
 * localhost). The board is normally opened over plain HTTP on a LAN IP
 * (e.g. http://192.168.10.25:8787), where it's undefined, so calling it
 * directly threw "crypto.randomUUID is not a function" and "+ Add step"
 * and edge connecting silently did nothing. `crypto.getRandomValues()`
 * is available in every context, so it builds the same RFC 4122 v4
 * shape when `randomUUID` is missing.
 *
 * `cryptoImpl` is injectable so tests can simulate an insecure context.
 */
export function newId(cryptoImpl: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
