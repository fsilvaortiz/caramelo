import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** The single "Caramelo" output channel shared by phases, tasks, analyze, constitution and hooks. */
export function getCarameloChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Caramelo');
  return channel;
}
