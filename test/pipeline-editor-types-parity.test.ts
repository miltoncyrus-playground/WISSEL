import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// pipeline-editor/src/types.ts deliberately hand-duplicates these four
// interfaces from src/core/types.ts rather than importing them (see
// docs/SDD-pipelines.md's revision callout under §3.2 -- the editor is a
// separate deployable unit and importing across that boundary would pull
// wissel's server-side dependency graph into a browser bundle). That
// isolation is a real trade-off, not free: nothing else stops the two
// files from silently drifting apart. This test is the drift-prevention
// mechanism named in that callout -- it fails the moment either side
// changes a field without the other following.

const SHARED_TYPES = ["PipelineStepDef", "PipelineEdgeDef", "PipelineGraph", "PipelineDef"];

interface FieldShape {
  name: string;
  optional: boolean;
  type: string;
}

function extractInterfaceShapes(filePath: string, interfaceNames: string[]): Map<string, FieldShape[]> {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const shapes = new Map<string, FieldShape[]>();

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && interfaceNames.includes(node.name.text)) {
      const fields: FieldShape[] = node.members
        .filter(ts.isPropertySignature)
        .map((member) => ({
          name: member.name.getText(sourceFile),
          optional: member.questionToken !== undefined,
          type: member.type ? normalizeType(member.type.getText(sourceFile)) : "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      shapes.set(node.name.text, fields);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return shapes;
}

// pipeline-editor/src/types.ts aliases "choose" | "all" as TransitionType
// and "any" | "all" as JoinMode; src/core/types.ts inlines the same union
// literals. Resolve both to the same canonical form before comparing so
// the alias-vs-inline styling difference isn't flagged as drift.
function normalizeType(typeText: string): string {
  const aliases: Record<string, string> = {
    TransitionType: `"choose" | "all"`,
    JoinMode: `"any" | "all"`,
  };
  return (aliases[typeText] ?? typeText).replace(/\s+/g, " ").trim();
}

test("pipeline-editor's hand-duplicated pipeline types match src/core/types.ts field-for-field", () => {
  const serverShapes = extractInterfaceShapes(join(import.meta.dir, "../src/core/types.ts"), SHARED_TYPES);
  const editorShapes = extractInterfaceShapes(
    join(import.meta.dir, "../pipeline-editor/src/types.ts"),
    SHARED_TYPES,
  );

  for (const name of SHARED_TYPES) {
    const server = serverShapes.get(name);
    const editor = editorShapes.get(name);
    expect(server, `src/core/types.ts is missing interface ${name}`).toBeDefined();
    expect(editor, `pipeline-editor/src/types.ts is missing interface ${name}`).toBeDefined();
    expect(editor, `${name} drifted between src/core/types.ts and pipeline-editor/src/types.ts`).toEqual(server);
  }
});
