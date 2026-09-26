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
import { createPipeline, getPipeline, listAgents, listPipelines, runPipeline, updatePipeline } from "./api";
import { flowToGraph, graphToFlow, incomingCounts, positionsOf, type StepNode as StepNodeType } from "./graph";
import { StepNode, type StepNodeInteractive } from "./components/StepNode";
import type { AgentDef, PipelineDef, PipelineStepDef, TaskCard } from "./types";

const nodeTypes = { step: StepNode };

/** Pulls the pipeline id out of a `/pipelines/edit` or
 *  `/pipelines/edit/<id>` URL — the one client-side route this SPA
 *  needs, so a dedicated router dependency would be overkill (see
 *  docs/SDD-pipelines.md §4's "and /pipelines/edit/:id for editing an
 *  existing one"). */
function pipelineIdFromLocation(): string | undefined {
  const prefix = "/pipelines/edit/";
  const path = window.location.pathname;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length).replace(/\/+$/, "");
  return rest.length > 0 ? decodeURIComponent(rest) : undefined;
}

function newStep(index: number, agents: AgentDef[]): PipelineStepDef {
  return {
    id: crypto.randomUUID(),
    name: `Step ${index + 1}`,
    agentId: agents[0]?.id ?? "",
    transition: "choose",
  };
}

export function App() {
  const [pipelineId, setPipelineId] = useState<string | undefined>(() => pipelineIdFromLocation());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [status, setStatus] = useState("");
  const [repo, setRepo] = useState("");
  const [runInput, setRunInput] = useState("");
  const [lastRunTask, setLastRunTask] = useState<TaskCard | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPipeline = useCallback(async (id: string) => {
    const def = await getPipeline(id);
    setPipelineId(def.id);
    setName(def.name);
    setDescription(def.description);
    const { nodes: loadedNodes, edges: loadedEdges } = graphToFlow(def.graph);
    setNodes(loadedNodes);
    setEdges(loadedEdges);
    setLastRunTask(null);
  }, [setNodes, setEdges]);

  // Cold load: agents (for the picker), the pipeline list (for the
  // load dropdown), and — if the URL names one — the pipeline itself.
  // Doubles as the "reload the page" acceptance check's own code path:
  // there's no separate rehydration mechanism, a browser reload just
  // re-runs this against the same URL.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentList, pipelineList] = await Promise.all([listAgents(), listPipelines()]);
        if (cancelled) return;
        setAgents(agentList);
        setPipelines(pipelineList);
        const id = pipelineIdFromLocation();
        if (id) await loadPipeline(id);
      } catch (err) {
        if (!cancelled) setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only — loadPipeline/setters are
    // stable across renders (useCallback/useState setters), and this
    // effect owns the cold-load path exclusively; loadPipeline is also
    // called directly (not via this effect) when the "Load" dropdown or
    // Save changes which pipeline is being edited mid-session.
  }, []);

  const incoming = useMemo(() => incomingCounts(edges), [edges]);

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

  // graph.ts's graphToFlow/flowToGraph stay pure and unit-testable; the
  // callbacks + live agents list every StepNode actually needs are
  // layered on here, right before nodes reach <ReactFlow>.
  const renderNodes = useMemo<(StepNodeType & { data: StepNodeType["data"] & StepNodeInteractive })[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          incomingCount: incoming.get(n.id) ?? 0,
          agents,
          onChange: (patch: Partial<PipelineStepDef>) => updateStep(n.id, patch),
          onDelete: () => deleteStep(n.id),
        },
      })),
    [nodes, agents, incoming, updateStep, deleteStep],
  );

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge({ ...connection, id: crypto.randomUUID() }, eds)),
    [setEdges],
  );

  // Edge labels are the last-resort match a "choose" step's pipeline-
  // handoff `next` resolves against (name, then id, then edge label —
  // see PipelineEdgeDef's own doc comment) — a double-click prompt is
  // the simplest possible editor for a field that's rarely needed and
  // doesn't warrant a dedicated custom-edge component.
  const onEdgeDoubleClick: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      const next = window.prompt("Edge label (used to resolve a \"choose\" step's next field):", typeof edge.label === "string" ? edge.label : "");
      if (next === null) return;
      setEdges((eds) => eds.map((e) => (e.id === edge.id ? { ...e, label: next } : e)));
    },
    [setEdges],
  );

  function addStep() {
    const step = newStep(nodes.length, agents);
    const position = { x: (nodes.length % 4) * 260 + 40, y: Math.floor(nodes.length / 4) * 200 + 40 };
    setNodes((nds) => [...nds, { id: step.id, type: "step", position, data: { step, incomingCount: 0 } }]);
  }

  function handleNew() {
    setPipelineId(undefined);
    setName("");
    setDescription("");
    setNodes([]);
    setEdges([]);
    setLastRunTask(null);
    setStatus("");
    window.history.pushState({}, "", "/pipelines/edit");
  }

  async function handleSave() {
    if (nodes.length === 0) {
      setStatus("Add at least one step before saving.");
      return;
    }
    if (nodes.some((n) => !n.data.step.agentId)) {
      setStatus("Every step needs an agent selected before saving.");
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
      setPipelineId(saved.id);
      window.history.pushState({}, "", `/pipelines/edit/${saved.id}`);
      setPipelines((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      // Re-derive nodes/edges from the saved graph (not just leave the
      // in-progress ones alone) so Save proves the exact round trip the
      // acceptance criteria's "save it, reload the page, confirm it
      // loads back identically" checks — carrying forward this session's
      // positions so it doesn't visibly reshuffle right after saving.
      const { nodes: savedNodes, edges: savedEdges } = graphToFlow(saved.graph, positions);
      setNodes(savedNodes);
      setEdges(savedEdges);
      setStatus(`Saved "${saved.name}".`);
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleRun() {
    if (!pipelineId) {
      setStatus("Save the pipeline before running it.");
      return;
    }
    if (!repo.trim() || !runInput.trim()) {
      setStatus("Repo and input are both required to run.");
      return;
    }
    setStatus("Running…");
    try {
      const root = await runPipeline(pipelineId, { repo: repo.trim(), input: runInput.trim() });
      setLastRunTask(root);
      setStatus(`Pipeline run created: task ${root.id} (${root.status}).`);
    } catch (err) {
      setStatus(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (loading) {
    return (
      <div className="pe-loading">
        <p>Loading pipeline editor…</p>
      </div>
    );
  }

  return (
    <div className="pe-app">
      <header className="pe-header">
        <div>
          <p className="pe-eyebrow">wissel</p>
          <h1>Pipeline editor</h1>
        </div>
        <a className="pe-back-link" href="/board">
          ← Back to board
        </a>
      </header>

      <div className="pe-toolbar">
        <div className="pe-toolbar-group">
          <label className="pe-field">
            <span>Load</span>
            <select
              value={pipelineId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (id) void loadPipeline(id).then(() => window.history.pushState({}, "", `/pipelines/edit/${id}`));
              }}
            >
              <option value="">Select a saved pipeline…</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={handleNew}>
            New pipeline
          </button>
        </div>

        <div className="pe-toolbar-group">
          <label className="pe-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pipeline name" />
          </label>
          <label className="pe-field">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </label>
        </div>

        <div className="pe-toolbar-group">
          <button type="button" onClick={addStep}>
            + Add step
          </button>
          <button type="button" className="pe-primary" onClick={() => void handleSave()}>
            Save
          </button>
        </div>
      </div>

      <div className="pe-canvas">
        <ReactFlow
          nodes={renderNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <div className="pe-run-panel">
        <label className="pe-field">
          <span>Repo</span>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/path/to/repo" />
        </label>
        <label className="pe-field">
          <span>Input</span>
          <input value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="What should this run do?" />
        </label>
        <button type="button" className="pe-primary" onClick={() => void handleRun()} disabled={!pipelineId}>
          Run
        </button>
        {lastRunTask && (
          <a className="pe-run-link" href="/board">
            Task {lastRunTask.id} created ({lastRunTask.status}) — open board →
          </a>
        )}
      </div>

      {status && <p className="pe-status">{status}</p>}
    </div>
  );
}
