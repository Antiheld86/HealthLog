import { Loader2 } from "lucide-react";

/**
 * Holds protected route trees until `/api/auth/me` has resolved the active
 * record and its capabilities. Mounting a child before this point can issue a
 * request for the actor's record before the shared-record scope is known.
 */
export function RecordScopeHydrationGate({ label }: { label: string }) {
  return (
    <div
      data-slot="record-scope-hydration-gate"
      className="flex h-dvh items-center justify-center"
      role="status"
    >
      <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
