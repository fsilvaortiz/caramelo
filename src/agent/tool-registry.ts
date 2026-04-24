import type {
  AgentToolCall,
  JSONSchema,
  JSONSchemaProperty,
  Tool,
  ToolContext,
  ToolResult,
} from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(initial: Tool[] = []) {
    for (const tool of initial) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a tool call: look up the tool, validate arguments against its
   * schema, run `execute`, convert exceptions into `is_error` results so the
   * loop can feed the error back to the model instead of crashing.
   */
  async execute(call: AgentToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        summary: `unknown tool: ${call.name}`,
        content:
          `error: tool "${call.name}" is not available. Available tools: ` +
          Array.from(this.tools.keys()).join(', '),
        isError: true,
      };
    }
    const validation = validateAgainstSchema(call.arguments, tool.inputSchema);
    if (!validation.ok) {
      return {
        summary: `invalid arguments for ${call.name}`,
        content: `error: ${validation.errors.join('; ')}`,
        isError: true,
      };
    }
    try {
      return await tool.execute(call.arguments as never, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        summary: `tool crashed: ${call.name}`,
        content: `error: ${call.name} threw: ${msg}`,
        isError: true,
      };
    }
  }
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Hand-rolled JSON Schema draft-07 validator. We deliberately support only
 * the small subset the built-in tools use (type, required, properties,
 * additionalProperties, enum, minimum/maximum, array items). Enough to
 * refuse bad input from the model but short enough to read in one sitting.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JSONSchema,
): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['arguments must be a JSON object'] };
  }
  const obj = value as Record<string, unknown>;

  for (const req of schema.required ?? []) {
    if (!(req in obj)) errors.push(`missing required field "${req}"`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) {
        errors.push(`unexpected field "${key}"`);
      }
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    validateProperty(obj[key], prop, key, errors);
  }

  return { ok: errors.length === 0, errors };
}

function validateProperty(
  value: unknown,
  prop: JSONSchemaProperty,
  path: string,
  errors: string[],
): void {
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`"${path}" must be a string`);
        return;
      }
      if (prop.enum && !prop.enum.includes(value)) {
        errors.push(`"${path}" must be one of ${prop.enum.join(', ')}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`"${path}" must be a finite number`);
        return;
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors.push(`"${path}" must be >= ${prop.minimum}`);
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors.push(`"${path}" must be <= ${prop.maximum}`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`"${path}" must be an integer`);
        return;
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors.push(`"${path}" must be >= ${prop.minimum}`);
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors.push(`"${path}" must be <= ${prop.maximum}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`"${path}" must be a boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`"${path}" must be an array`);
        return;
      }
      if (prop.items) {
        for (let i = 0; i < value.length; i++) {
          validateProperty(value[i], prop.items, `${path}[${i}]`, errors);
        }
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`"${path}" must be an object`);
      }
      break;
  }
}
