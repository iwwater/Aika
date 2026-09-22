// K65-09: metadata-only management projection. It never receives secrets or activates a package.
export function renderNext65Packages(root, packages) {
  root.replaceChildren();
  for (const item of packages) {
    const row = document.createElement('article');
    row.dataset.packageId = item.packageId;
    row.textContent = `${item.packageId} · ${item.installed.map(version => version.version).join(', ')} · ${item.enabled ? 'enabled' : 'disabled'}${item.pendingVersion ? ` · restart:${item.pendingVersion}` : ''}`;
    root.append(row);
  }
}

export function renderNext65Diagnostics(root, diagnostics) {
  root.replaceChildren();
  for (const item of diagnostics) {
    const row = document.createElement('article');
    row.dataset.stageId = item.stageId;
    row.textContent = `${item.profileId}@${item.profileRevision} · ${item.stageId} · ${item.status} · ${item.detail}`;
    root.append(row);
  }
}
