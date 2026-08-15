import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "./useCloudInstance";

const CLOUD_SIGN_OUT_PATH = "/cloud/logout";

interface UseSignOutOptions {
  onSignedOut?: () => void;
}

/**
 * Owns the app-wide sign-out decision.
 *
 * Cloud-managed tenants must enter the harness-owned logout sequence without
 * first clearing the tenant session. Authenticated self-hosted instances keep
 * the local API flow and invalidate the auth-dependent caches afterward.
 */
export function useSignOut({ onSignedOut }: UseSignOutOptions = {}) {
  const cloud = useCloudInstance();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (cloud) {
        onSignedOut?.();
        navigateTopLevel(CLOUD_SIGN_OUT_PATH);
        return "cloud" as const;
      }

      await authApi.signOut();
      return "self-hosted" as const;
    },
    onSuccess: async (target) => {
      if (target === "cloud") return;

      onSignedOut?.();
      // If this grows into a sweep of the account-scoped caches, clear them with
      // `resetQueries`, not `removeQueries`. Removal does not notify observers
      // that are already subscribed — nothing rebinds them until some other
      // change forces a render — so the entry disappears while every mounted
      // observer keeps serving the signed-out account's value, and the redirect
      // in CloudAccessGate that fires on the session going empty never runs.
      // Reset notifies, the refetch returns null, and the app leaves. Measured
      // against query-core 5.101.4: removal produced 0 notifications and left
      // the observer holding the old session; reset produced 3 and null.
      //
      // The opposite advice holds for a *local* reset under an observer that
      // stays mounted (InviteLanding, the onboarding draft gate): reset rewinds
      // the update counters `isFetchedAfterMount` is derived from while that
      // observer keeps its bind-time baseline, so the flag can never read true
      // again and the gate withholds forever. Those spots avoid reset. Sign-out
      // is not one of them: it resets the session too, so those consumers
      // redirect, unmount, and remount fresh.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
  });
}
