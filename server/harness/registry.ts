// Provider instance registry — port of upstream's ProviderInstanceRegistryLive behavior, minus Effect.
export { engineMemory } from "../engine-memory.ts";
import type { InstanceId, ProviderInstance } from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

export function enginesByUse(selections: ReadonlyArray<{ instanceId: InstanceId } | undefined>): InstanceId[] {
  const uses = new Map<InstanceId, number>();
  for (const selection of selections) if (selection?.instanceId) uses.set(selection.instanceId, (uses.get(selection.instanceId) ?? 0) + 1);
  return [...uses].sort((a, b) => b[1] - a[1]).map(([instanceId]) => instanceId);
}

export {
  SNAPSHOT_DEADLINE_MS,
  SNAPSHOT_REUSE_MS,
  START_READ_STEP_MS,
} from "./provider-registry.ts";
export { ProviderRegistry } from "./provider-registry-class.ts";
