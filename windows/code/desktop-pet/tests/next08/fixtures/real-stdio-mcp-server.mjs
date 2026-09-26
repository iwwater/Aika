#!/usr/bin/env node
/**
 * Real standalone stdio MCP server fixture.
 * Implements MCP specification (2026-07-28 and 2025-11-25 handshake) over stdio.
 * Performs genuine computations and tool invocations.
 */

import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'calculate_sum',
    description: 'Calculate the mathematical sum of two numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'system_echo',
    description: 'Echoes the input message with timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
  },
];

async function handle(message) {
  const method = message.method;
  const params = message.params ?? {};

  if (method === 'server/discover') {
    return {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'aika-real-stdio-mcp-server',
        version: '1.0.0',
      },
    };
  }

  if (method === 'initialize') {
    return {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'aika-real-stdio-mcp-server',
        version: '1.0.0',
      },
    };
  }

  if (method === 'notifications/initialized') {
    return {};
  }

  if (method === 'ping') {
    return {};
  }

  if (method === 'tools/list') {
    return { resultType: 'complete', tools };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'calculate_sum') {
      const a = Number(args?.a ?? 0);
      const b = Number(args?.b ?? 0);
      const sum = a + b;
      return {
        resultType: 'complete',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ operation: 'sum', a, b, result: sum }),
          },
        ],
        isError: false,
      };
    }

    if (name === 'system_echo') {
      const msg = String(args?.message ?? '');
      return {
        resultType: 'complete',
        content: [
          {
            type: 'text',
            text: `Echo: ${msg} [processed_by_real_mcp_at_${new Date().toISOString()}]`,
          },
        ],
        isError: false,
      };
    }

    return {
      resultType: 'complete',
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  throw new Error(`Method not supported: ${method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', async line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.id === undefined) {
    // Notification
    return;
  }

  let response;
  try {
    const result = await handle(message);
    response = { jsonrpc: '2.0', id: message.id, result };
  } catch (error) {
    response = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  process.stdout.write(JSON.stringify(response) + '\n');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
