import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME, META_FILE_NAME } from '../constants.js';
import { buildSpec, writeMetadata, type Spec } from './spec.js';

export class SpecWorkspace {
  private readonly workspaceUri: vscode.Uri;
  private readonly _onDidChangeSpecs = new vscode.EventEmitter<void>();
  readonly onDidChangeSpecs = this._onDidChangeSpecs.event;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(workspaceUri: vscode.Uri) {
    this.workspaceUri = workspaceUri;
    this.setupWatcher();
  }

  private setupWatcher(): void {
    const pattern = new vscode.RelativePattern(this.workspaceUri, `${SPECS_DIR_NAME}/**`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => this._onDidChangeSpecs.fire());
    this.watcher.onDidChange(() => this._onDidChangeSpecs.fire());
    this.watcher.onDidDelete(() => this._onDidChangeSpecs.fire());
  }

  getSpecsRoot(): string {
    const root = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return root;
  }

  listSpecs(): Spec[] {
    const root = this.getSpecsRoot();
    if (!fs.existsSync(root)) return [];

    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => buildSpec(e.name, path.join(root, e.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  createSpec(name: string, _description: string): Spec {
    const root = this.getSpecsRoot();
    const dirPath = path.join(root, name);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    const metaPath = path.join(dirPath, META_FILE_NAME);
    if (!fs.existsSync(metaPath)) {
      writeMetadata(metaPath, {
        requirements: 'pending',
        design: 'pending',
        tasks: 'pending',
      });
    }

    return buildSpec(name, dirPath);
  }

  getConstitution(): string | undefined {
    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    if (fs.existsSync(constitutionPath)) {
      return fs.readFileSync(constitutionPath, 'utf-8');
    }
    return undefined;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChangeSpecs.dispose();
  }
}
