/**
 * Per-project execution settings (docs/SDD-project-settings.md): the
 * extra sandbox domains, the verification contract, the worktree setup
 * commands and the protected paths a non-Bun target repo needs. Stored
 * on `Project` by SqliteProjectStore.setSettings, set with `POST
 * /projects/:id/settings`. This module only validates; nothing here
 * changes how a run behaves.
 *
 * A project with none of them set behaves, and serialises, exactly as
 * before they existed.
 */

import type { Project } from "../core/types.ts";
import { grantError, MAX_EXTRA_ALLOWED_TOOLS } from "../core/allowed-tools.ts";

export const MAX_SANDBOX_DOMAINS = 20;
export const MAX_SETTING_COMMANDS = 20;
export const MAX_PROTECTED_PATHS = 50;

/** The four settings, as stored on Project. */
export type ProjectSettings = Pick<Project, "sandboxAllowedDomains" | "verification" | "worktreeSetup" | "protectedPaths" | "harness">;
export type ProjectSettingKey = keyof Required<ProjectSettings>;
export const PROJECT_SETTING_KEYS: readonly ProjectSettingKey[] = ["sandboxAllowedDomains", "verification", "worktreeSetup", "protectedPaths", "harness"];

/** A partial update: a key that's absent is left alone, `null` clears
 *  it. An empty list (or a verification with no commands and no tools)
 *  is stored as cleared too, so "set to nothing" and "never set" read
 *  back the same. */
export type ProjectSettingsPatch = { [K in ProjectSettingKey]?: NonNullable<ProjectSettings[K]> | null };

export type ProjectSettingsCheck = { ok: true; patch: ProjectSettingsPatch } | { ok: false; error: string };

/** One DNS label: letters, digits, inner hyphens, at most 63 chars. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A bare hostname with at least two labels, optionally `*.`-prefixed
 *  with at least two labels after it (`*.pypi.org`, never `*.org`). No
 *  scheme, port, path, or uppercase. */
const HOST_RE = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
const WILDCARD_HOST_RE = new RegExp(`^\\*\\.${LABEL}(?:\\.${LABEL})+$`);

/** Why one domain is refused, or undefined when it's acceptable. */
export function domainError(entry: string): string | undefined {
  if (entry === "*" || entry === "*.*" || /^\*\.[^.]*$/.test(entry)) return `"${entry}" would allow every host; name the hosts (e.g. "pypi.org", "*.pythonhosted.org")`;
  if (entry.length > 253 || !(HOST_RE.test(entry) || WILDCARD_HOST_RE.test(entry))) {
    return `"${entry}" is not a bare lowercase hostname like "pypi.org" (no scheme, port or path; "*." prefix allowed)`;
  }
  return undefined;
}

/** Why one protected path is refused, or undefined when it's acceptable:
 *  a non-empty repo-relative glob, no `..` segment, no absolute or home
 *  path, forward slashes only. */
export function protectedPathError(entry: string): string | undefined {
  if (entry === "") return "protected paths must be non-empty";
  if (entry.startsWith("/") || entry.startsWith("~") || /^[A-Za-z]:/.test(entry)) return `"${entry}" must be relative to the repo root`;
  if (entry.includes("\\")) return `"${entry}" must use forward slashes`;
  if (entry.includes("\0")) return `"${entry}" contains a NUL byte`;
  if (entry.split("/").includes("..")) return `"${entry}" must not contain ".."`;
  return undefined;
}

function argvListError(name: string, value: unknown): string | undefined {
  if (!Array.isArray(value)) return `${name} must be a list of commands, each a list of strings (argv)`;
  if (value.length > MAX_SETTING_COMMANDS) return `${name} has ${value.length} commands; at most ${MAX_SETTING_COMMANDS}`;
  for (const c of value) {
    if (!Array.isArray(c) || c.length === 0 || !c.every((a) => typeof a === "string" && a !== "")) {
      return `each ${name} command must be a non-empty list of non-empty strings, got ${JSON.stringify(c)}`;
    }
  }
  return undefined;
}

function stringListError(name: string, value: unknown, max: number, check: (entry: string) => string | undefined): string | undefined {
  if (!Array.isArray(value)) return `${name} must be a list of strings`;
  if (value.length > max) return `${name} has ${value.length} entries; at most ${max}`;
  for (const entry of value) {
    if (typeof entry !== "string") return `${name} must be a list of strings`;
    const error = check(entry);
    if (error) return `${name}: ${error}`;
  }
  return undefined;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Validates a `POST /projects/:id/settings` body into a patch. Every key
 * is optional; unknown keys are refused so a typo can't silently do
 * nothing. The first problem found is the error.
 */
export function validateProjectSettings(body: unknown): ProjectSettingsCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: `settings must be an object with any of: ${PROJECT_SETTING_KEYS.join(", ")}` };
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(PROJECT_SETTING_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown setting "${key}"; expected any of: ${PROJECT_SETTING_KEYS.join(", ")}` };
    }
  }
  const patch: ProjectSettingsPatch = {};

  if ("sandboxAllowedDomains" in raw) {
    const v = raw.sandboxAllowedDomains;
    if (v === null) patch.sandboxAllowedDomains = null;
    else {
      const error = stringListError("sandboxAllowedDomains", v, MAX_SANDBOX_DOMAINS, domainError);
      if (error) return { ok: false, error };
      const domains = dedupe(v as string[]);
      patch.sandboxAllowedDomains = domains.length > 0 ? domains : null;
    }
  }

  if ("verification" in raw) {
    const v = raw.verification;
    if (v === null) patch.verification = null;
    else {
      if (typeof v !== "object" || Array.isArray(v)) {
        return { ok: false, error: 'verification must be an object { "commands": [[argv...]], "allowedTools": ["Bash(...)"] }' };
      }
      const { commands, allowedTools, ...rest } = v as Record<string, unknown>;
      const extra = Object.keys(rest)[0];
      if (extra !== undefined) return { ok: false, error: `unknown verification field "${extra}"; expected commands, allowedTools` };
      const cmdError = argvListError("verification.commands", commands);
      if (cmdError) return { ok: false, error: cmdError };
      const toolError = stringListError("verification.allowedTools", allowedTools, MAX_EXTRA_ALLOWED_TOOLS, grantError);
      if (toolError) return { ok: false, error: toolError };
      const tools = dedupe(allowedTools as string[]);
      const cmds = commands as string[][];
      patch.verification = cmds.length > 0 || tools.length > 0 ? { commands: cmds, allowedTools: tools } : null;
    }
  }

  if ("worktreeSetup" in raw) {
    const v = raw.worktreeSetup;
    if (v === null) patch.worktreeSetup = null;
    else {
      const error = argvListError("worktreeSetup", v);
      if (error) return { ok: false, error };
      patch.worktreeSetup = (v as string[][]).length > 0 ? (v as string[][]) : null;
    }
  }

  if ("protectedPaths" in raw) {
    const v = raw.protectedPaths;
    if (v === null) patch.protectedPaths = null;
    else {
      const error = stringListError("protectedPaths", v, MAX_PROTECTED_PATHS, protectedPathError);
      if (error) return { ok: false, error };
      const paths = dedupe(v as string[]);
      patch.protectedPaths = paths.length > 0 ? paths : null;
    }
  }

  if ("harness" in raw) {
    const v = raw.harness;
    if (v === null) patch.harness = null;
    else if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v)) {
      return { ok: false, error: "harness must be a harness id (letters, digits, . _ -), or null to clear it" };
    } else patch.harness = v;
  }

  return { ok: true, patch };
}
