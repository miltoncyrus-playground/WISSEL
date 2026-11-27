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

import type { Project, ReviewPolicy } from "../core/types.ts";
import { grantError, MAX_EXTRA_ALLOWED_TOOLS } from "../core/allowed-tools.ts";
import { MAX_REF_PATTERNS, patternError } from "./ticket-refs.ts";
import { validateDelivery } from "./delivery.ts";
import { CARD_TEMPLATE_KINDS, MAX_CARD_RULES_CHARS, templateError, type CardTemplateKind } from "../core/card-templates.ts";

export const MAX_SANDBOX_DOMAINS = 20;
export const MAX_SETTING_COMMANDS = 20;
export const MAX_PROTECTED_PATHS = 50;

/** The settings, as stored on Project. */
export type ProjectSettings = Pick<Project, "sandboxAllowedDomains" | "verification" | "worktreeSetup" | "protectedPaths" | "harness" | "ticketPatterns" | "referencePatterns" | "cardRules" | "cardTemplates" | "env" | "delivery" | "reviewPolicy">;
export type ProjectSettingKey = keyof Required<ProjectSettings>;
export const PROJECT_SETTING_KEYS: readonly ProjectSettingKey[] = ["sandboxAllowedDomains", "verification", "worktreeSetup", "protectedPaths", "harness", "ticketPatterns", "referencePatterns", "cardRules", "cardTemplates", "env", "delivery", "reviewPolicy"];

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

export const MAX_PROJECT_ENV = 20;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names a project may not set: Wissel's own settings, the variables
 *  that choose an account or a tool's config (a harness's job), the
 *  ones that change what runs (PATH, loader and git hooks), and anything
 *  that looks like a credential, which never belongs in the board. */
const ENV_REFUSED = [/^WISSEL_/, /^CLAUDE_/, /^ANTHROPIC_/, /^CODEX_/, /^OPENAI_/, /^GIT_/, /^LD_/, /^DYLD_/, /^(PATH|HOME|USER|LOGNAME|SHELL|NODE_OPTIONS|BUN_OPTIONS)$/, /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|_KEY$|^KEY$/];

/** Why a project env entry is refused, or undefined. */
export function projectEnvError(name: string, value: unknown): string | undefined {
  if (!ENV_NAME.test(name)) return `env name "${name}" must be upper-case letters, digits and underscores, starting with a letter or underscore`;
  if (ENV_REFUSED.some((r) => r.test(name))) return `env "${name}" can't be set per project: it names Wissel's own settings, an account or tool config, what runs, or a credential`;
  if (typeof value !== "string" || value.length > 1000 || /[\0\n\r]/.test(value)) return `env "${name}" must be a single line of text, at most 1000 characters`;
  return undefined;
}

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

  for (const key of ["ticketPatterns", "referencePatterns"] as const) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (v === null) patch[key] = null;
    else {
      const error = stringListError(key, v, MAX_REF_PATTERNS, patternError);
      if (error) return { ok: false, error };
      const patterns = dedupe(v as string[]);
      patch[key] = patterns.length > 0 ? patterns : null;
    }
  }

  if ("reviewPolicy" in raw) {
    const v = raw.reviewPolicy;
    if (v === null) patch.reviewPolicy = null;
    else {
      if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: 'reviewPolicy must be an object: { "maxRounds": 2, "blocks": ["HIGH"], "atCap": "ask-decider" }' };
      const r = v as Record<string, unknown>;
      const extra = Object.keys(r).find((k) => !["maxRounds", "blocks", "atCap"].includes(k));
      if (extra) return { ok: false, error: `unknown reviewPolicy field "${extra}"; expected maxRounds, blocks, atCap` };
      if (r.maxRounds !== undefined && !(Number.isInteger(r.maxRounds) && (r.maxRounds as number) >= 0 && (r.maxRounds as number) <= 10)) return { ok: false, error: "reviewPolicy.maxRounds must be a whole number from 0 to 10" };
      const blockKinds = ["HIGH", "MED", "MED-with-scenario"];
      if (r.blocks !== undefined && !(Array.isArray(r.blocks) && r.blocks.every((b) => typeof b === "string" && blockKinds.includes(b)))) return { ok: false, error: `reviewPolicy.blocks must list any of ${blockKinds.join(", ")}` };
      if (r.atCap !== undefined && !["ask-decider", "spec-question", "accept"].includes(r.atCap as string)) return { ok: false, error: "reviewPolicy.atCap must be ask-decider, spec-question or accept" };
      const policy = {
        ...(r.maxRounds !== undefined ? { maxRounds: r.maxRounds as number } : {}),
        ...(r.blocks !== undefined && (r.blocks as string[]).length ? { blocks: dedupe(r.blocks as string[]) as NonNullable<ReviewPolicy["blocks"]> } : {}),
        ...(r.atCap !== undefined ? { atCap: r.atCap as NonNullable<ReviewPolicy["atCap"]> } : {}),
      };
      patch.reviewPolicy = Object.keys(policy).length > 0 ? policy : null;
    }
  }

  if ("delivery" in raw) {
    const checked = validateDelivery(raw.delivery);
    if (!checked.ok) return { ok: false, error: checked.error };
    patch.delivery = checked.delivery;
  }

  if ("env" in raw) {
    const v = raw.env;
    if (v === null) patch.env = null;
    else {
      if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: 'env must be an object of names to values, such as { "TMPDIR": "/data/tmp" }' };
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > MAX_PROJECT_ENV) return { ok: false, error: `env has ${entries.length} entries; at most ${MAX_PROJECT_ENV}` };
      for (const [name, value] of entries) {
        const error = projectEnvError(name, value);
        if (error) return { ok: false, error };
      }
      patch.env = entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : null;
    }
  }

  if ("cardRules" in raw) {
    const v = raw.cardRules;
    if (v === null) patch.cardRules = null;
    else if (typeof v !== "string") return { ok: false, error: "cardRules must be text (or null to clear it)" };
    else if (v.length > MAX_CARD_RULES_CHARS) return { ok: false, error: `cardRules is ${v.length} characters; at most ${MAX_CARD_RULES_CHARS}` };
    else patch.cardRules = v.trim() ? v : null;
  }

  if ("cardTemplates" in raw) {
    const v = raw.cardTemplates;
    if (v === null) patch.cardTemplates = null;
    else {
      if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `cardTemplates must be an object keyed by kind (${CARD_TEMPLATE_KINDS.join(", ")})` };
      const templates: Partial<Record<CardTemplateKind, string>> = {};
      for (const [kind, text] of Object.entries(v as Record<string, unknown>)) {
        if (!(CARD_TEMPLATE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `unknown card template kind "${kind}"; expected any of: ${CARD_TEMPLATE_KINDS.join(", ")}` };
        if (typeof text !== "string") return { ok: false, error: `cardTemplates.${kind} must be text` };
        const error = templateError(text);
        if (error) return { ok: false, error: `cardTemplates.${kind} ${error}` };
        if (text.trim()) templates[kind as CardTemplateKind] = text;
      }
      patch.cardTemplates = Object.keys(templates).length > 0 ? templates : null;
    }
  }

  return { ok: true, patch };
}

/** The env for one card run: the project's (Project.env), then the
 *  harness's own on top, so the account a harness points at can never be
 *  redirected by a project. Undefined when neither sets anything, which
 *  keeps a run's env exactly as before. */
export function runEnv(projectEnv: Record<string, string> | undefined, harnessEnv: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!projectEnv && !harnessEnv) return undefined;
  return { ...projectEnv, ...harnessEnv };
}
