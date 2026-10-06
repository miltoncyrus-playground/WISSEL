import { describe, expect, test } from "vitest";
import { newId } from "../src/id";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An insecure context (plain HTTP on a LAN IP): getRandomValues exists,
// randomUUID doesn't. This is how the board is normally opened, and why
// "+ Add step" threw "crypto.randomUUID is not a function".
const insecure = { getRandomValues: <T extends ArrayBufferView | null>(a: T) => globalThis.crypto.getRandomValues(a) };

describe("newId", () => {
  test("uses crypto.randomUUID when the context provides it", () => {
    expect(newId({ getRandomValues: insecure.getRandomValues, randomUUID: () => "from-randomUUID" })).toBe("from-randomUUID");
  });

  test("falls back to a valid v4 UUID when randomUUID is missing (insecure context)", () => {
    for (let i = 0; i < 200; i++) expect(newId(insecure)).toMatch(V4);
  });

  test("fallback ids don't repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId(insecure)));
    expect(ids.size).toBe(1000);
  });

  test("sets the version and variant bits even when every random byte is 0xff or 0x00", () => {
    const fill = (v: number) => ({ getRandomValues: <T extends ArrayBufferView | null>(a: T) => (new Uint8Array((a as unknown as Uint8Array).buffer).fill(v), a) });
    expect(newId(fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(newId(fill(0x00))).toBe("00000000-0000-4000-8000-000000000000");
  });

  test("defaults to the real global crypto", () => {
    expect(newId()).toMatch(V4);
  });
});
