import * as fs from 'fs';
import * as path from 'path';
import { CACHE_DIR, TEMPLATES_CACHE_DIR, VERSION_FILE, SPEC_KIT_API_URL } from '../constants.js';

interface VersionInfo {
  tag: string;
  downloadedAt: string;
  etag?: string;
}

export class TemplateSync {
  async checkForUpdates(force = false): Promise<{ updated: boolean; version?: string }> {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const current = this.readVersionInfo();
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'caramelo-vscode-extension',
    };
    if (!force && current?.etag) {
      headers['If-None-Match'] = current.etag;
    }

    const res = await fetch(SPEC_KIT_API_URL, { headers, signal: AbortSignal.timeout(10000) });

    if (res.status === 304) {
      return { updated: false, version: current?.tag };
    }

    if (!res.ok) {
      console.warn(`Caramelo: Template sync failed (${res.status})`);
      return { updated: false, version: current?.tag };
    }

    const release = await res.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    const newTag = release.tag_name;

    if (!force && current?.tag === newTag) {
      return { updated: false, version: newTag };
    }

    // Find the generic template asset
    const asset = release.assets.find((a: { name: string }) => a.name.includes('generic') && a.name.endsWith('.zip'));
    if (!asset) {
      console.warn('Caramelo: No generic template asset found in release');
      return { updated: false, version: current?.tag };
    }

    await this.downloadAndExtract(asset.browser_download_url);

    const versionInfo: VersionInfo = {
      tag: newTag,
      downloadedAt: new Date().toISOString(),
      etag: res.headers.get('etag') ?? undefined,
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(versionInfo, null, 2));

    return { updated: true, version: newTag };
  }

  private async downloadAndExtract(url: string): Promise<void> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'caramelo-vscode-extension' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());

    // Simple zip extraction — find .md files in the zip
    // For MVP, we extract using Node's built-in capabilities via process
    if (!fs.existsSync(TEMPLATES_CACHE_DIR)) fs.mkdirSync(TEMPLATES_CACHE_DIR, { recursive: true });

    const tmpZip = path.join(CACHE_DIR, 'templates.zip');
    fs.writeFileSync(tmpZip, buffer);

    // Use unzip command (available on macOS/Linux)
    const { execSync } = await import('child_process');
    try {
      execSync(`unzip -o "${tmpZip}" -d "${TEMPLATES_CACHE_DIR}"`, { stdio: 'pipe' });
    } catch {
      console.warn('Caramelo: unzip failed, templates may not be extracted');
    }
    try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
  }

  private readVersionInfo(): VersionInfo | null {
    try {
      const raw = fs.readFileSync(VERSION_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  getCurrentVersion(): string | undefined {
    return this.readVersionInfo()?.tag;
  }
}
