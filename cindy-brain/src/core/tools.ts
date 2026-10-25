import { z } from "zod";
import { RecallOptions, RecallHit } from "../types";

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string; code: string };

export interface ToolCtx {
  recall: (query: string, opts?: RecallOptions) => Promise<RecallHit[]>;
  remember: (text: string, kind: string) => Promise<string>;
  forget: (id: string) => Promise<boolean>;
  createTask: (spec: unknown) => Promise<{ id: string }>;
  updateTask: (id: string, action: string) => Promise<unknown>;
  nodeCmd: (op: string, args: unknown) => Promise<unknown>;
  browserAct: (action: string, params: unknown) => Promise<unknown>;
  filePush: (name: string, content: string) => Promise<unknown>;
  filePull: (name: string) => Promise<unknown>;
  notify: (text: string) => Promise<void>;
}

const s = {
  string: z.string().max(8192),
  id: z.string().max(128),
  json: z.record(z.string(), z.unknown()),
};

export const TOOLS: Record<string, { schema: z.ZodTypeAny; description: string }> = {
  "memory.recall": {
    description: "Search long-term memory. Returns provenanced hits.",
    schema: z.object({
      query: z.string().max(512),
      k: z.number().int().min(1).max(20).optional(),
      kinds: z.array(z.enum(["episodic", "semantic", "procedural", "artifact", "working"])).optional(),
      since: z.number().optional(),
      task_id: z.string().max(128).optional(),
    }),
  },
  "memory.remember": {
    description: "Store a fact in long-term memory (prefer 'semantic' for facts).",
    schema: z.object({ text: s.string, kind: z.enum(["semantic", "episodic", "procedural", "working"]) }),
  },
  "memory.forget": {
    description: "Soft-delete a memory chunk by id.",
    schema: z.object({ id: s.id }),
  },
  "tasks.create": {
    description: "Create a task for the hands (node) to execute.",
    schema: z.object({
      spec: z.object({
        title: z.string().max(256),
        goal: z.string().max(4096),
        steps: z.array(z.string().max(2048)).max(20),
        acceptance: z.array(z.string().max(1024)).max(10),
        estimated_minutes: z.number().int().min(1).max(600),
        requires_caps: z.array(z.enum(["shell", "browser", "files"])).max(3),
      }),
    }),
  },
  "tasks.update": {
    description: "Update a task: cancel | retry | requeue | done.",
    schema: z.object({ id: s.id, action: z.enum(["cancel", "retry", "requeue", "done"]) }),
  },
  "node.cmd": {
    description: "Run an op on the hands node. Fails gracefully if hands offline.",
    schema: z.object({
      op: z.enum(["shell.run", "browser.act", "file.push", "file.pull"]),
      args: s.json,
    }),
  },
  "browser.act": {
    description: "Drive the node's local browser over CDP.",
    schema: z.object({
      action: z.enum(["navigate", "click", "type", "screenshot", "evaluate"]),
      params: s.json,
    }),
  },
  "files.push": { description: "Push a file to the node workspace.", schema: z.object({ name: s.string, content: s.string }) },
  "files.pull": { description: "Pull a file from the node workspace.", schema: z.object({ name: s.string }) },
  notify: {
    description: "Send a Telegram notification to the owner.",
    schema: z.object({ text: z.string().max(2048) }),
  },
};

export function toolDefs() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    type: "function" as const,
    function: {
      name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema),
    },
  }));
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal zod→JSON-schema conversion for the shapes used above.
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
      if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string" };
    if (schema.maxLength !== undefined) out.maxLength = schema.maxLength;
    return out;
  }
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(schema.element as z.ZodTypeAny) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault() as z.ZodTypeAny);
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  return { type: "object" };
}

export function validateToolArgs(name: string, args: unknown): ToolResult {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `unknown tool: ${name}`, code: "unknown_tool" };
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `invalid args for ${name}: ${parsed.error.message.slice(0, 256)}`, code: "invalid_args" };
  }
  return { ok: true, result: parsed.data };
}

export async function dispatchTool(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const v = validateToolArgs(name, args);
  if (!v.ok) return v;
  const a = v.result as Record<string, any>;
  try {
    switch (name) {
      case "memory.recall":
        return { ok: true, result: await ctx.recall(a.query, { k: a.k, kinds: a.kinds, since: a.since, task_id: a.task_id }) };
      case "memory.remember":
        return { ok: true, result: { id: await ctx.remember(a.text, a.kind) } };
      case "memory.forget":
        return { ok: true, result: { deleted: await ctx.forget(a.id) } };
      case "tasks.create":
        return { ok: true, result: await ctx.createTask(a.spec) };
      case "tasks.update":
        return { ok: true, result: await ctx.updateTask(a.id, a.action) };
      case "node.cmd": {
        if (a.op === "browser.act") return { ok: true, result: await ctx.browserAct(a.args?.action, a.args?.params) };
        if (a.op === "file.push") return { ok: true, result: await ctx.filePush(a.args?.name, a.args?.content ?? "") };
        if (a.op === "file.pull") return { ok: true, result: await ctx.filePull(a.args?.name) };
        return { ok: true, result: await ctx.nodeCmd(a.op, a.args) };
      }
      case "browser.act":
        return { ok: true, result: await ctx.browserAct(a.action, a.params) };
      case "files.push":
        return { ok: true, result: await ctx.filePush(a.name, a.content) };
      case "files.pull":
        return { ok: true, result: await ctx.filePull(a.name) };
      case "notify":
        await ctx.notify(a.text);
        return { ok: true, result: { sent: true } };
      default:
        return { ok: false, error: `unknown tool: ${name}`, code: "unknown_tool" };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 512), code: "tool_error" };
  }
}
