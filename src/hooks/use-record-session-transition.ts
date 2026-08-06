"use client";

import { useSyncExternalStore } from "react";
import {
  getRecordSessionTransition,
  subscribeToRecordSessionTransition,
  type RecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";

const SERVER_TRANSITION: RecordSessionTransition = {
  id: null,
  phase: "ready",
  expectedScope: undefined,
};

function getServerRecordSessionTransition(): RecordSessionTransition {
  return SERVER_TRANSITION;
}

/** The tab-local view of a browser-wide record-session transition. */
export function useRecordSessionTransition(): RecordSessionTransition {
  return useSyncExternalStore(
    subscribeToRecordSessionTransition,
    getRecordSessionTransition,
    getServerRecordSessionTransition,
  );
}
