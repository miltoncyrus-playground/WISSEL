import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ProjectsSection, gitLine } from "../src/components/ProjectsSection";
import { TaskRow } from "../src/components/TaskRow";
import { cardTicket, projectOf, ticketKey } from "../src/ticket";
import { ProjectsContext } from "../src/useProjects";
import type { ProjectInfo, TaskCard } from "../src/types";

const project: ProjectInfo = { id: "p1", name: "repo-one", path: "/work/repo-one", ticketPatterns: ["ABC-\\d+"] };
const card = (over: Partial<TaskCard> = {}): TaskCard => ({ id: "1a2b3c4d-0000-4000-8000-000000000001", title: "Do it", body: "", labels: [], status: "inbox", ...over });

describe("ticketKey", () => {
  test("the default finds a PROJ-123 key; a project's own patterns replace it", () => {
    expect(ticketKey(["spec/ABC-943-desks"])).toBe("ABC-943");
    expect(ticketKey(["spec/ABC-943-desks"], ["XYZ-\\d+"])).toBeUndefined();
    expect(ticketKey([undefined, "", "feat/XYZ-7-x"], ["XYZ-\\d+"])).toBe("XYZ-7");
  });
  test("a pattern that does not compile finds nothing, and does not throw", () => {
    expect(ticketKey(["ABC-1"], ["("])).toBeUndefined();
  });
});

describe("cardTicket", () => {
  test("title first, then the branch, under the card's project's patterns", () => {
    expect(cardTicket(card({ repo: "/work/repo-one/", title: "ABC-5: go" }), [project])).toBe("ABC-5");
    expect(cardTicket(card({ repo: "/work/repo-one", mergeTarget: "feat/ABC-9-x" }), [project])).toBe("ABC-9");
    expect(projectOf(card({ repo: "/work/other" }), [project])).toBeUndefined();
    expect(cardTicket(card({ title: "ABC-5" }), [])).toBe("ABC-5");
  });
});

test("a card row names its ticket when the project is known, and nothing extra when not", () => {
  const html = (projects: ProjectInfo[]) =>
    renderToStaticMarkup(
      <ProjectsContext.Provider value={projects}>
        <TaskRow task={card({ repo: "/work/repo-one", title: "ABC-5 go" })} lane="running" />
      </ProjectsContext.Provider>,
    );
  expect(html([project])).toContain("ABC-5");
  expect(html([])).toContain("ABC-5"); // the default pattern still finds it
  expect(renderToStaticMarkup(<TaskRow task={card({ title: "plain" })} lane="running" />)).not.toContain("ABC-");
});

describe("gitLine", () => {
  const base = { branch: "main", detached: false, dirty: false, changedFiles: 0, hasUpstream: true };
  test("clean, dirty, ahead/behind, no upstream, detached", () => {
    expect(gitLine(base)).toBe("main · clean");
    expect(gitLine({ ...base, dirty: true, changedFiles: 1 })).toBe("main · 1 changed file");
    expect(gitLine({ ...base, ahead: 2, behind: 1 })).toBe("main · clean · 2 ahead, 1 behind");
    expect(gitLine({ ...base, hasUpstream: false })).toBe("main · clean · no upstream");
    expect(gitLine({ ...base, detached: true, branch: "abc123" })).toBe("detached at abc123 · clean");
  });
});

describe("ProjectsSection", () => {
  test("renders nothing without projects, and one closed row per project", () => {
    expect(renderToStaticMarkup(<ProjectsSection />)).toBe("");
    const html = renderToStaticMarkup(
      <ProjectsContext.Provider value={[project]}>
        <ProjectsSection />
      </ProjectsContext.Provider>,
    );
    expect(html).toContain("repo-one");
    expect(html).toContain('aria-expanded="false"');
  });
});
