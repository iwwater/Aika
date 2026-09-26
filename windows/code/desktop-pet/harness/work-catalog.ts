import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { ProjectIndexPort, ProjectEntry } from '../contracts/projects.js';
import type { ForwardTargets } from '../contracts/harness.js';
export type WorkProject = ProjectEntry & { source: 'index' | 'task_directory' };
/** Only indexed metadata and verified user-task directories. No project file contents. */
export async function workProjects(index: ProjectIndexPort, targets: ForwardTargets['items']): Promise<WorkProject[]> {
  const result: WorkProject[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await index.list({ limit: 100, offset });
    result.push(...page.items.map(p => ({ ...p, source: 'index' as const })));
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
  const roots = new Set(result.map(p => p.detailRef.rootPath));
  for (const target of targets) {
    if (!isAbsolute(target.projectPath) || roots.has(target.projectPath)) continue;
    try {
      const root = await realpath(target.projectPath);
      if (!(await stat(root)).isDirectory() || roots.has(root)) continue;
      roots.add(root);
      result.push({ id: 'directory-' + createHash('sha256').update(root).digest('hex').slice(0, 24),
        name: basename(root), abstract: '已有 Codex 任务所在目录', detailRef: { rootPath: root },
        source: 'task_directory', version: 1, updatedAt: '' });
    } catch { /* Unavailable directories are not invented as selectable projects. */ }
  }
  return result;
}
