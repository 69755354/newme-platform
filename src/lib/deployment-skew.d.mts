export const DEPLOYMENT_ID_HEADER: "x-newme-deployment-id";
export const RELEASE_PROBE_INTERVAL_MS: number;
export function clientDeploymentId(): string | null;
export function isDeploymentMismatch(serverId: string | null | undefined, clientId?: string | null): boolean;
export function isVersionSkewError(error: unknown): boolean;
export function reloadOnceForVersionSkew(options?: {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  location?: Pick<Location, "reload"> | null;
  clientId?: string | null;
}): boolean;
export function reloadIfServerReleaseDiffers(headers: Pick<Headers, "get">): boolean;
export function subscribeUpdateAvailable(listener: () => void): () => void;
export function isUpdateAvailable(): boolean;
export function probeServerRelease(options?: { fetchImpl?: typeof fetch; now?: number; force?: boolean }): Promise<boolean>;
export function resetReleaseProbeForTests(): void;
