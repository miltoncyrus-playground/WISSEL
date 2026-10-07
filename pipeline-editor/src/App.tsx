import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
} from "@xyflow/react";
import { createPipeline, getPipeline, listAgents, listPipelines, updatePipeline } from "./api";
import { flowToGraph, graphToFlow, incomingCounts, positionsOf, type StepNode as StepNodeType } from "./graph";
import { StepNode, type StepNodeInteractive } from "./components/StepNode";
import { StepPanel } from "./components/StepPanel";
import { newId } from "./id";
import { blankDraft, builtInTemplates, draftFromPipeline, templateChoices, type PipelineDraft } from "./templates";
import { useBoardColorMode } from "./useBoardColorMode";
import type { EditorHost, EditorRoute } from "./host";
import type { AgentDef, PipelineDef, PipelineStepDef } from "./types";

const nodeTypes = { step: StepNode };

function newStep(index: number, agents: AgentDef[]): PipelineStepDef {
  return {
    id: newId(),
    name: `Step ${index + 1}`,
    agentId: agents[0]?.id ?? "",
    transition: "choose",
  };
}

/** What Save would send, minus layout: compared against the last
 *  saved/loaded value to tell whether the canvas has unsaved changes. */
function snapshotOf(name: string, description: string, nodes: StepNodeType[], edges: Edge[]): string {
  return JSON.stringify({ name, description, graph: flowToGraph(nodes, edges) });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Phase = "loading" | "choose" | "editing" | "failed";

interface AppProps {
  route: EditorRoute;
  host: EditorHost;
}

/** The pipeline editor, mounted inside the board shell
 *  (docs/SDD-ui-cleanup.md §4.2). A new pipeline starts at a choice:
 *  blank, or a copy of any saved pipeline. Clicking a step opens the
 *  step side panel. Save creates or updates the pipeline over the
 *  /pipelines API; Run hands the saved pipeline to the board's "+ New"
 *  drawer. The host remounts this component (a new React key) on every
 *  navigation into the editor, so `route` is read once, on mount. */
export function App({ route, host }: AppProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [pipelineId, setPipelineId] = useState<string | undefined>(route.mode === "edit" ? route.pipelineId : undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [status, setStatus] = useState("");
  // null: nothing saved yet (a new draft), so any content is unsaved.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const colorMode = useBoardColorMode();

  const openDraft = useCallback(
    (draft: PipelineDraft) => {
      const { nodes: draftNodes, edges: draftEdges } = graphToFlow(draft.graph);
      setName(draft.name);
      setDescription(draft.description);
      setNodes(draftNodes);
      setEdges(draftEdges);
      setStatus("");
      setPhase("editing");
    },
    [setNodes, setEdges],
  );

  // Cold load: agents (for the panel's picker), saved pipelines (the
  // "start from" list), and the pipeline itself when editing one. A
  // browser reload of #/pipelines/edit/<id> runs exactly this again.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentList, pipelineList] = await Promise.all([listAgents(), listPipelines()]);
        if (cancelled) return;
        setAgents(agentList);
        setPipelines(pipelineList);
        if (route.mode === "new") {
          setPhase("choose");
          return;
        }
        const def = await getPipeline(route.pipelineId);
        if (cancelled) return;
        openDraft(def);
        const loaded = graphToFlow(def.graph);
        setSavedSnapshot(snapshotOf(def.name, def.description, loaded.nodes, loaded.edges));
      } catch (err) {
        if (cancelled) return;
        setStatus(`Failed to load: ${errorText(err)}`);
        setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount only: the host remounts on navigation (see AppProps).
  }, []);

  const incoming = useMemo(() => incomingCounts(edges), [edges]);
  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const selectedNode = nodes.find((n) => n.selected) ?? null;
  const dirty = phase === "editing" && snapshotOf(name, description, nodes, edges) !== savedSnapshot;

  // "Saved …" stops being true at the next edit.
  useEffect(() => {
    if (dirty) setStatus((s) => (s.startsWith("Saved") ? "" : s));
  }, [dirty]);

  const updateStep = useCallback(
    (stepId: string, patch: Partial<PipelineStepDef>) => {
      setNodes((nds) => nds.map((n) => (n.id === stepId ? { ...n, data: { ...n.data, step: { ...n.data.step, ...patch } } } : n)));
    },
    [setNodes],
  );

  const deleteStep = useCallback(
    (stepId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== stepId));
      setEdges((eds) => eds.filter((e) => e.source !== stepId && e.target !== stepId));
    },
    [setNodes, setEdges],
  );

  const clearSelection = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  }, [setNodes]);

  // graph.ts's graphToFlow/flowToGraph stay pure; the live incoming
  // count and agent name each StepNode shows are layered on here.
  const renderNodes = useMemo<(StepNodeType & { data: StepNodeType["data"] & StepNodeInteractive })[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: { ...n.data, incomingCount: incoming.get(n.id) ?? 0, agentName: agentNames.get(n.data.step.agentId) },
      })),
    [nodes, incoming, agentNames],
  );

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge({ ...connection, id: newId() }, eds)),
    [setEdges],
  );

  // Edge labels are the last-resort match a "choose" step's handoff
  // `next` resolves against (name, then id, then edge label; see
  // PipelineEdgeDef). A double-click prompt is enough for a field
  // that's rarely needed.
  const onEdgeDoubleClick: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      const next = window.prompt('Edge label (used to resolve a "choose" step\'s next field):', typeof edge.label === "string" ? edge.label : "");
      if (next === null) return;
      setEdges((eds) => eds.map((e) => (e.id === edge.id ? { ...e, label: next } : e)));
    },
    [setEdges],
  );

  // A new step lands in the next grid slot, selected, so the side panel
  // opens on it straight away.
  function addStep() {
    const step = newStep(nodes.length, agents);
    const position = { x: (nodes.length % 4) * 260 + 40, y: Math.floor(nodes.length / 4) * 200 + 40 };
    setNodes((nds) => [
      ...nds.map((n) => (n.selected ? { ...n, selected: false } : n)),
      { id: step.id, type: "step", position, selected: true, data: { step, incomingCount: 0 } },
    ]);
  }

  async function handleSave() {
    if (nodes.length === 0) {
      setStatus("Add at least one step before saving.");
      return;
    }
    if (nodes.some((n) => !n.data.step.agentId)) {
      setStatus("Every step needs an agent before saving.");
      return;
    }
    if (!name.trim()) {
      setStatus("Name the pipeline before saving.");
      return;
    }
    const graph = flowToGraph(nodes, edges);
    setStatus("Saving…");
    try {
      const saved = pipelineId ? await updatePipeline(pipelineId, { name, description, graph }) : await createPipeline({ name, description, graph });
      const positions = positionsOf(nodes);
      const selectedId = selectedNode?.id;
      if (saved.id !== pipelineId) host.setRoute({ mode: "edit", pipelineId: saved.id });
      setPipelineId(saved.id);
      setPipelines((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      // Re-derive nodes/edges from what the server stored, so Save shows
      // exactly what a reload would load, keeping this session's layout
      // and selection so nothing jumps.
      const { nodes: savedNodes, edges: savedEdges } = graphToFlow(saved.graph, positions);
      setNodes(savedNodes.map((n) => (n.id === selectedId ? { ...n, selected: true } : n)));
      setEdges(savedEdges);
      setName(saved.name);
      setDescription(saved.description);
      setSavedSnapshot(snapshotOf(saved.name, saved.description, savedNodes, savedEdges));
      setStatus(`Saved "${saved.name}".`);
    } catch (err) {
      setStatus(`Save failed: ${errorText(err)}`);
    }
  }

  function handleRun() {
    if (!pipelineId) {
      setStatus("Save the pipeline before running it.");
      return;
    }
    if (dirty) {
      setStatus("Unsaved changes: Save first. Run starts the saved pipeline.");
      return;
    }
    host.runPipeline(pipelineId);
  }

  if (phase === "loading") {
    return (
      <div className="pe-app pe-centered">
        <p className="pe-muted">Loading pipeline editor…</p>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="pe-app">
        <div className="pe-toolbar">
          <a className="pe-back" href="#/pipelines">
            ← Pipelines
          </a>
        </div>
        <p className="pe-status pe-status-block">{status}</p>
      </div>
    );
  }

  if (phase === "choose") {
    const templates = templateChoices(pipelines);
    return (
      <div className="pe-app">
        <div className="pe-toolbar">
          <a className="pe-back" href="#/pipelines">
            ← Pipelines
          </a>
          <h1 className="pe-title">New pipeline</h1>
        </div>
        <div className="pe-choices">
          <section className="pe-choice" aria-labelledby="peStartBlankTitle">
            <h2 id="peStartBlankTitle">Start blank</h2>
            <p className="pe-muted">An empty canvas. Add steps, pick their agents, connect them.</p>
            <button type="button" className="pe-btn pe-primary" onClick={() => openDraft(blankDraft())}>
              Start blank
            </button>
          </section>
          <section className="pe-choice" aria-labelledby="peStartFromTitle">
            <h2 id="peStartFromTitle">Start from a saved pipeline</h2>
            <p className="pe-muted">A copy you can change and save as a new pipeline. The original stays as it is.</p>
            {templates.length === 0 ? (
              <p className="pe-muted">No saved pipelines yet.</p>
            ) : (
              <ul className="pe-template-list">
                {templates.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="pe-template" data-pipeline-id={p.id} aria-label={`Start from ${p.name}`} onClick={() => openDraft(draftFromPipeline(p))}>
                      <span className="pe-template-name">{p.name}</span>
                      <span className="pe-template-meta">
                        {p.graph.steps.length === 1 ? "1 step" : `${p.graph.steps.length} steps`}
                        {p.description ? ` · ${p.description}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="pe-choice pe-choice-templates" aria-labelledby="peStartTemplateTitle">
            <h2 id="peStartTemplateTitle">Start from a template</h2>
            <p className="pe-muted">A ready-made pipeline to change and save as your own.</p>
            <ul className="pe-template-list">
              {builtInTemplates().map((t) => (
                <li key={t.name}>
                  <button type="button" className="pe-template" data-template-name={t.name} aria-label={`Start from template ${t.name}`} onClick={() => openDraft(t)}>
                    <span className="pe-template-name">{t.name}</span>
                    <span className="pe-template-meta">
                      {t.graph.steps.length === 1 ? "1 step" : `${t.graph.steps.length} steps`}
                      {t.description ? ` · ${t.description}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    );
  }

  const selectedStepId = selectedNode?.id;

  return (
    <div className="pe-app">
      <div className="pe-toolbar">
        <a className="pe-back" href="#/pipelines">
          ← Pipelines
        </a>
        <label className="pe-field pe-inline">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pipeline name" aria-label="Pipeline name" />
        </label>
        <label className="pe-field pe-inline pe-grow">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" aria-label="Description" />
        </label>
        {status && (
          <span className="pe-status" role="status">
            {status}
          </span>
        )}
        {dirty && !status && <span className="pe-dirty">Unsaved</span>}
        <button type="button" className="pe-btn" onClick={addStep}>
          + Add step
        </button>
        <button type="button" className="pe-btn pe-primary" onClick={() => void handleSave()}>
          Save
        </button>
        <button type="button" className="pe-btn" onClick={handleRun} disabled={!pipelineId} title={pipelineId ? "Run the saved pipeline" : "Save the pipeline first"}>
          Run
        </button>
      </div>

      <div className="pe-body">
        <div className="pe-canvas">
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeDoubleClick={onEdgeDoubleClick}
            colorMode={colorMode}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <StepPanel
          key={selectedStepId ?? "none"}
          step={selectedNode ? selectedNode.data.step : null}
          incomingCount={selectedStepId ? incoming.get(selectedStepId) ?? 0 : 0}
          agents={agents}
          onChange={(patch) => {
            if (selectedStepId) updateStep(selectedStepId, patch);
          }}
          onDelete={() => {
            if (selectedStepId) deleteStep(selectedStepId);
          }}
          onClose={clearSelection}
        />
      </div>
    </div>
  );
}
