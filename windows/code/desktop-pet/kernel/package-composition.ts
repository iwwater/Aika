import type { CapabilityProviderRef } from '../contracts/plugin.js';
import type { PackageHost, PluginRequest } from '../plugins/host-runtime.js';

/**
 * Production composition boundary for installed capability packages. The kernel asks the host to
 * resolve the explicitly bound provider, then invokes the executable adapter carried by that
 * artifact. No development-tree provider import is involved.
 */
export async function executePackageCapability(
  host: PackageHost,
  request: PluginRequest,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const providers = await host.resolve(signal ? { ...request, signal } : request);
  const provider = selectProvider(providers, request.bindingId);
  if (!provider?.execute) throw new Error(`installed provider ${request.capabilityId} has no executable adapter`);
  return await provider.execute(input, signal);
}

function selectProvider(providers: readonly CapabilityProviderRef[], bindingId: string | undefined): CapabilityProviderRef | undefined {
  // bindingId is deliberately explicit at the composition boundary. A package may expose multiple
  // adapters for one capability, so falling back to import order would make the flow non-deterministic.
  if (!bindingId) return providers.length === 1 ? providers[0] : undefined;
  return providers.find(provider => provider.adapterId === bindingId);
}
