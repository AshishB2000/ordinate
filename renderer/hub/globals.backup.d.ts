// Additive globals for backups and sync (settingsBackups.ts, projectSync.ts) —
// kept apart from the shared globals.d.ts, like globals.platform.d.ts, so
// concurrent branches do not collide on it. Classic-script functions need no
// declaration here; only the preload bridge does.

// preload/hubBackupPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubBackup: {
    settings(): Promise<any>;
    set(patch: { cadence?: string; keep?: number }): Promise<any>;
    chooseFolder(): Promise<any>;
    useDefaultFolder(): Promise<any>;
    revealFolder(): Promise<any>;
    backUpNow(): Promise<any>;
    list(): Promise<any>;
    restore(id: string): Promise<any>;
    onChanged(cb: (view: any) => void): () => void;
    syncStatus(id: string): Promise<any>;
    syncTake(id: string): Promise<any>;
    syncConflicts(id: string): Promise<string[]>;
    revealConflict(id: string, rel: string): Promise<any>;
    revealSyncFolder(id: string): Promise<any>;
    moveToSyncFolder(id: string): Promise<any>;
    openFromFolder(): Promise<any>;
    moveBack(id: string): Promise<any>;
    relaunch(): Promise<any>;
    onLockLost(cb: (info: any) => void): () => void;
  };
}
