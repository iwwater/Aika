// K65-04 optional compatibility package. Long-memory ownership remains in the host's existing store;
// this package only declares the context/background capabilities and never starts audio or vision.
const capabilities = [
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'local_read', execution: ['unary'], capabilityId: 'context.source', category: 'context_source', adapterId: 'compatibility.memory', parameters: ['maxItems', 'budgetTokens', 'scope', 'dedupe', 'minScore'], inputs: [{ name: 'scope', type: 'scope', required: true, description: '会话范围' }], outputs: [{ name: 'context', type: 'object', required: true, description: '长期上下文引用' }] },
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'local_write', execution: ['unary'], capabilityId: 'background.lifecycle', category: 'background_lifecycle', adapterId: 'compatibility.lifecycle', parameters: ['pollIntervalMs', 'startPolicy', 'watchdogMs', 'idleStopMs'], inputs: [{ name: 'scope', type: 'scope', required: true, description: '后台范围' }], outputs: [{ name: 'status', type: 'object', required: true, description: '维护状态' }] },
];
export const activation = {
  activate(host) {
    for (const capability of capabilities) host.capabilities.register({ ...capability, provide: { capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion, pluginId: host.pluginId, packageId: host.packageId } });
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '0.65.0', apiVersion: '1.0.0', state: 'active', capabilityIds: capabilities.map(capability => capability.capabilityId) };
  },
  deactivate() {},
};
