// The MCP protocol layer — JSON-RPC 2.0 over the command registry. Pure: no
// Electron, no I/O. The stdio transport (headless.ts) and the HTTP transport
// (httpTransport.ts) both hand each parsed message here and write back what
// it returns (null = a notification, nothing to send).
//
// Implemented by hand, deliberately — it is five methods: initialize,
// notifications/initialized, ping, tools/list, tools/call. A protocol error
// (bad JSON, unknown method, unknown tool, arguments that fail the schema) is a
// JSON-RPC error; a tool that RAN and failed (no such dataset, SQL rejected) is
// a normal result with `isError: true`, which is what MCP clients show the model.

import { AutomationError } from './errors';
import type { Command, Transport } from './registry';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

type Id = string | number | null;
export type RpcResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

export function rpcError(id: Id, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export interface McpOptions {
  commands: readonly Command[];
  dispatch: (cmd: Command, raw: unknown, opts: { transport: Transport; headless: boolean }) => Promise<unknown>;
  transport: Transport;
  headless: boolean;
  version: string;
  /** Checked on every tools/call: a message when automation was switched off since start. */
  gate?: () => string | null;
}

/** The tool list as MCP publishes it — the registry's own schema, verbatim. */
export function toolList(commands: readonly Command[], schemaOf: (c: Command) => unknown): unknown[] {
  return commands.filter((c) => c.tool).map((c) => ({
    name: c.tool,
    title: c.tool!.split('_').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' '),
    description: c.summary,
    inputSchema: schemaOf(c),
    annotations: { readOnlyHint: c.readOnly, destructiveHint: false, idempotentHint: c.readOnly, openWorldHint: false },
  }));
}

export function createHandler(opts: McpOptions, schemaOf: (c: Command) => unknown): (msg: unknown) => Promise<RpcResponse | null> {
  return async (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, RPC.invalidRequest, 'Invalid Request');
    const m = msg as Record<string, unknown>;
    const id: Id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
    const isNotification = !('id' in m);
    // A response from the client (to a request we never send) — nothing to answer.
    if (typeof m.method !== 'string') return 'result' in m || 'error' in m ? null : rpcError(id, RPC.invalidRequest, 'Invalid Request');
    if (m.jsonrpc !== '2.0') return isNotification ? null : rpcError(id, RPC.invalidRequest, 'Invalid Request: jsonrpc must be "2.0"');
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });

    switch (m.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ordinate', title: 'Ordinate', version: opts.version },
          instructions: 'Ordinate is a local BI workspace. Start with list_datasets and describe_dataset; '
            + 'use aggregate or query_sql for numbers (the app computes every figure). Every tool is read-only '
            + 'except create_visual and create_dashboard, which save records and never change data.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolList(opts.commands, schemaOf) });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const cmd = opts.commands.find((c) => c.tool === name);
        if (!cmd) return rpcError(id, RPC.invalidParams, `Unknown tool: ${name || '(none)'}`);
        const closed = opts.gate ? opts.gate() : null;
        if (closed) return ok(toolError(closed));
        try {
          const result = await opts.dispatch(cmd, params.arguments, { transport: opts.transport, headless: opts.headless });
          const out: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
          if (result && typeof result === 'object' && !Array.isArray(result)) out.structuredContent = result;
          return ok(out);
        } catch (e) {
          // Arguments that fail the registry schema are the CALLER's protocol error.
          if (e instanceof AutomationError && e.code === 'usage' && e.stage === 'args') return rpcError(id, RPC.invalidParams, e.message);
          return ok(toolError(e instanceof Error && e.message ? e.message : 'Something went wrong.'));
        }
      }
      default:
        return rpcError(id, RPC.methodNotFound, `Method not found: ${m.method}`);
    }
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
