// The permission check in front of every route (docs/SDD-identity-and-
// permissions.md §4.3, card 6). Inside the authorization records, so a
// refusal is recorded as denied with its reason. One middleware, one
// check: the route table (WRITE_ROUTES) says what a write needs and where
// it lands; a write it doesn't declare is the owner's alone.
import type { GrantStore, Place, PlaceFrom } from "../services/permissions.ts";
import { requirementFor } from "../services/permissions.ts";
import { OWNER_PRINCIPAL_ID } from "../services/authorization.ts";
import { principalOf } from "./sign-in.ts";

type Fetch = (req: Request) => Response | Promise<Response>;

const permitted = new WeakSet<Request>();

/** Whether the middleware let this request through. Owner-only checks
 *  inside the app defer to it, so a granted permission is honoured. */
export function wasPermitted(req: Request): boolean {
  return permitted.has(req);
}

export interface PermissionDoorOptions {
  grants: GrantStore;
  /** Where an action lands, from its path. */
  placeOf: (from: PlaceFrom, parts: string[]) => Promise<Place | undefined>;
}

export function withPermissions(inner: Fetch, opts: PermissionDoorOptions): Fetch {
  return async (req) => {
    const url = new URL(req.url);
    const who = principalOf(req);
    const need = requirementFor(req.method, url.pathname);
    const deny = (error: string) => new Response(JSON.stringify({ error }), { status: 403, headers: { "Content-Type": "application/json" } });
    // The owner holds everything: no place to look up, no grant to read.
    if (who === OWNER_PRINCIPAL_ID) {
      permitted.add(req);
      return inner(req);
    }
    if (need.needs === "owner") {
      if (who !== OWNER_PRINCIPAL_ID) return deny(`${req.method} ${url.pathname} declares no permission, so only the owner may use it`);
    } else if (need.needs !== "self") {
      const place = need.place === "instance" ? undefined : await opts.placeOf(need.place, url.pathname.split("/").filter(Boolean).map(decodeURIComponent));
      const missing = need.needs.filter((p) => !opts.grants.can(who, p, place));
      if (missing.length) return deny(`this needs ${missing.join(", ")}${place ? " here" : ""}`);
    }
    permitted.add(req);
    return inner(req);
  };
}
