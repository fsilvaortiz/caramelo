import type { Tool } from '../types.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { listDirTool } from './list-dir.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { bashTool } from './bash.js';

export interface ToolSetOptions {
  /** When false, bash is omitted entirely from the returned list. */
  enableBash: boolean;
}

export function buildDefaultToolSet(options: ToolSetOptions): Tool[] {
  const tools: Tool[] = [
    fileReadTool,
    listDirTool,
    grepTool,
    globTool,
    fileEditTool,
    fileWriteTool,
  ];
  if (options.enableBash) tools.push(bashTool);
  return tools;
}

export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  listDirTool,
  grepTool,
  globTool,
  bashTool,
};
