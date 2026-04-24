import { describe, it, expect } from 'vitest';
import { ToolRegistry, validateAgainstSchema } from '../tool-registry.js';
import type { Tool, ToolContext } from '../types.js';
import { nodeFs } from '../tools/io.js';

function mockContext(): ToolContext {
  const controller = new AbortController();
  return {
    workspaceRoot: '/tmp',
    signal: controller.signal,
    log: () => { /* noop */ },
    io: nodeFs,
  };
}

describe('validateAgainstSchema', () => {
  it('accepts well-formed input', () => {
    const result = validateAgainstSchema(
      { path: 'src/a.ts', start_line: 1 },
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = validateAgainstSchema(
      {},
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/path/);
  });

  it('rejects wrong types', () => {
    const result = validateAgainstSchema(
      { path: 42 },
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/must be a string/);
  });

  it('enforces integer vs number', () => {
    const result = validateAgainstSchema(
      { n: 1.5 },
      {
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/integer/);
  });

  it('enforces minimum/maximum', () => {
    const schema = {
      type: 'object' as const,
      properties: { n: { type: 'integer' as const, minimum: 1, maximum: 10 } },
      required: ['n'],
    };
    expect(validateAgainstSchema({ n: 0 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ n: 11 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ n: 5 }, schema).ok).toBe(true);
  });

  it('rejects additional properties when forbidden', () => {
    const result = validateAgainstSchema(
      { path: 'a', extra: 'b' },
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/extra/);
  });

  it('rejects non-object argument payloads', () => {
    const schema = { type: 'object' as const, properties: {} };
    expect(validateAgainstSchema('string', schema).ok).toBe(false);
    expect(validateAgainstSchema(null, schema).ok).toBe(false);
    expect(validateAgainstSchema([1, 2], schema).ok).toBe(false);
  });

  it('catches schema-author typos where required names a field not in properties', () => {
    // If the validator silently accepted this, a tool author could write
    // `required: ['paht']` (typo) and receive no argument validation for
    // the real `path` field.
    const result = validateAgainstSchema(
      { path: 'a.ts' },
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['paht'], // typo
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('schema author error'))).toBe(true);
  });
});

describe('ToolRegistry.execute', () => {
  const echoTool: Tool<{ msg: string }> = {
    name: 'echo',
    description: 'echoes msg back',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
    async execute(input) {
      return { summary: `echoed ${input.msg}`, content: input.msg };
    },
  };

  it('runs a registered tool with valid arguments', async () => {
    const registry = new ToolRegistry([echoTool]);
    const result = await registry.execute(
      { id: '1', name: 'echo', arguments: { msg: 'hi' } },
      mockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('hi');
  });

  it('returns is_error for unknown tool names', async () => {
    const registry = new ToolRegistry([echoTool]);
    const result = await registry.execute(
      { id: '1', name: 'ghost', arguments: {} },
      mockContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not available/i);
  });

  it('returns is_error for schema-invalid arguments', async () => {
    const registry = new ToolRegistry([echoTool]);
    const result = await registry.execute(
      { id: '1', name: 'echo', arguments: { msg: 42 } as never },
      mockContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/string/);
  });

  it('converts tool-throwing errors into is_error results', async () => {
    const brokenTool: Tool = {
      name: 'broken',
      description: 'always throws',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        throw new Error('boom');
      },
    };
    const registry = new ToolRegistry([brokenTool]);
    const result = await registry.execute(
      { id: '1', name: 'broken', arguments: {} },
      mockContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/boom/);
  });

  it('refuses duplicate tool registration', () => {
    const registry = new ToolRegistry([echoTool]);
    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });
});
