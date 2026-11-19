import { z } from "zod";
import { KINDS, type Kind } from "./model.js";
import type { Operation } from "./operation.js";
import type { GraphView } from "./graph.js";
import { LINK_TYPES, type LinkType } from "./link-types.js";

export const FEATURES = ["tasks", "decisions"] as const;
export type Feature = (typeof FEATURES)[number];

/** Projects (also ID prefixes), identity and storage are shared infrastructure. */
export class FeatureSelection {
  readonly enabled: readonly Feature[];
  private readonly descriptions = new WeakMap<Operation, Operation>();
  private readonly views = new WeakMap<GraphView, GraphView>();
  constructor(selection: readonly Feature[] = FEATURES) {
    if (!selection.length || selection.some(feature => !FEATURES.includes(feature))) throw new Error("Enable at least one supported feature: tasks, decisions.");
    this.enabled = Object.freeze([...new Set(selection)]);
  }
  has(feature: Feature): boolean { return this.enabled.includes(feature); }
  get profileTag(): {feature_profile?: string} {
    return this.enabled.length === FEATURES.length ? {} : {feature_profile: FEATURES.filter(f => this.has(f)).join(",")};
  }
  kind(kind: Kind): boolean { return kind === "task" ? this.has("tasks") : kind === "decision" ? this.has("decisions") : true; }
  /** Reads use the same filtered graph for links and for derived project progress/problems. */
  view(graph: GraphView): GraphView {
    if (this.enabled.length === FEATURES.length) return graph;
    const known = this.views.get(graph);
    if (known) return known;
    const visible = (link: { from: {kind: Kind}; to: {kind: Kind} }) => this.kind(link.from.kind) && this.kind(link.to.kind);
    const view: GraphView = {
      get: (kind,id) => this.kind(kind) ? graph.get(kind,id) : undefined,
      node: ref => this.kind(ref.kind) ? graph.node(ref) : undefined,
      all: kind => this.kind(kind) ? graph.all(kind) : [],
      out: (ref,type) => graph.out(ref,type).filter(visible), in: (ref,type) => graph.in(ref,type).filter(visible),
      findLink: link => visible(link) ? graph.findLink(link) : undefined,
      links: () => graph.links().filter(visible), userByName: name => graph.userByName(name),
      everything: () => graph.everything().filter(n => this.kind(n.kind)),
    };
    this.views.set(graph,view);
    return view;
  }
  operation(name: string): boolean {
    if (["create_decision", "update_decision", "list_decisions"].includes(name)) return this.has("decisions");
    if (["create_task", "update_task", "list_tasks", "list_next_tasks", "list_stale_tasks", "set_task_status", "override_timestamp"].includes(name)) return this.has("tasks");
    return true;
  }
  links(): LinkType[] {
    return LINK_TYPES.map(t => ({ ...t, from: t.from.filter(k => this.kind(k)), to: t.to.filter(k => this.kind(k)) })).filter(t => t.from.length && t.to.length);
  }
  /** One narrowed schema is used both to advertise and to parse the call. */
  profile(op: Operation): Operation {
    if (this.enabled.length === FEATURES.length) return op;
    const known = this.descriptions.get(op);
    if (known) return known;
    let input = op.input;
    if (["get", "delete", "restore", "list_history"].includes(op.name)) {
      input = input.safeExtend({ kind: z.enum(KINDS.filter(k => this.kind(k))).optional() });
    }
    const description = ({
      get: "Read an enabled item by ID, including current links and optionally history. Continue a cut list with its continuation token.",
      delete: "Hide an enabled item, or permanently delete it as admin.",
      restore: "Restore a soft-deleted enabled item.",
      get_guide: "Read the guide for the features enabled on this instance; each topic lists available topics.",
      add_link: "Add an explicit link between enabled items. Use list_link_types for supported relationships.",
      remove_link: "Remove a link between enabled items. Use list_link_types for supported relationships.",
    } as Record<string,string>)[op.name] ?? op.description;
    const resolved = { ...op, input, description } as Operation;
    this.descriptions.set(op, resolved);
    return resolved;
  }
}
