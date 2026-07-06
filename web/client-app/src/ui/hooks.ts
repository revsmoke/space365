import { useSyncExternalStore } from 'react';
import { stdb, type StoreEvent } from '../stdb';

/** Re-render when a store event fires; returns the event version counter. */
export function useStore(event: StoreEvent): number {
  return useSyncExternalStore(
    cb => stdb.on(event, () => cb()),
    () => stdb.version(event)
  );
}
