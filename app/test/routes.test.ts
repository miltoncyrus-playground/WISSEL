import { describe, expect, test } from "vitest";
import { DEFAULT_SCREEN, SCREENS, parseRoute, routeHash } from "../src/routes";

describe("parseRoute", () => {
  test("no hash lands on the default screen", () => {
    expect(parseRoute("")).toEqual({ screen: DEFAULT_SCREEN, known: true });
    expect(parseRoute("#")).toEqual({ screen: DEFAULT_SCREEN, known: true });
    expect(parseRoute("#/")).toEqual({ screen: DEFAULT_SCREEN, known: true });
  });

  test("every screen has a route, with or without a trailing slash", () => {
    for (const s of SCREENS) {
      expect(parseRoute(`#/${s.id}`)).toEqual({ screen: s.id, known: true });
      expect(parseRoute(`#/${s.id}/`)).toEqual({ screen: s.id, known: true });
    }
  });

  test("tabs are Feed, Ask, Board, Listen, You in that order", () => {
    expect(SCREENS.map((s) => s.label)).toEqual(["Feed", "Ask", "Board", "Listen", "You"]);
  });

  test("#/board/<id> opens a card, decoded", () => {
    expect(parseRoute("#/board/abc-123")).toEqual({ screen: "board", taskId: "abc-123", known: true });
    expect(parseRoute("#/board/a%20b")).toEqual({ screen: "board", taskId: "a b", known: true });
  });

  test("unknown or malformed hashes fall back without throwing", () => {
    expect(parseRoute("#/nope")).toEqual({ screen: DEFAULT_SCREEN, known: false });
    expect(parseRoute("#/constructor")).toEqual({ screen: DEFAULT_SCREEN, known: false });
    expect(parseRoute("#/board/%E0%A4%A")).toEqual({ screen: "board", known: false });
    expect(parseRoute("#/feed/extra")).toEqual({ screen: "feed", known: false });
    expect(parseRoute("#/board/a/b")).toEqual({ screen: "board", known: false });
  });
});

describe("routeHash", () => {
  test("round-trips through parseRoute", () => {
    for (const s of SCREENS) expect(parseRoute(routeHash({ screen: s.id })).screen).toBe(s.id);
    const odd = "id/with spaces#and?query";
    expect(parseRoute(routeHash({ screen: "board", taskId: odd })).taskId).toBe(odd);
  });
});
