import { computed, onScopeDispose, ref, shallowRef } from "vue";
import type {
  DeploymentResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { AuthError } from "../auth/session";
import type { ApiRequest } from "./client";
import { createRuntimeClient } from "./runtime-client";

type Action = "start" | "stop";
const active = (operation: RuntimeOperationResponse | null) =>
  operation?.status === "queued" || operation?.status === "running";

export function useConfigRuntime(id: string, request: ApiRequest) {
  const client = createRuntimeClient(request);
  const deployment = shallowRef<DeploymentResponse | null>(null);
  const operation = shallowRef<RuntimeOperationResponse | null>(null);
  const checked = ref(false);
  const statusError = ref("");
  const actionError = ref("");
  const submitting = ref<Action | null>(null);
  const accepted = shallowRef<{ id: string; type: Action } | null>(null);
  let retry:
    | {
        type: Action;
        revisionId: string | undefined;
        key: string;
        previousOperationId: string | undefined;
      }
    | undefined;
  const uncertain = ref(false);
  let observer: AbortController | undefined;
  let command: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let failures = 0;

  const pendingAction = computed(
    () =>
      submitting.value ??
      accepted.value?.type ??
      (active(operation.value) ? operation.value!.type : null),
  );
  const state = computed(() => {
    if (statusError.value) return "unknown";
    if (pendingAction.value)
      return pendingAction.value === "start" ? "starting" : "stopping";
    if (!checked.value) return "unknown";
    return deployment.value?.state ?? "not_started";
  });
  const canAct = computed(
    () => checked.value && !statusError.value && !pendingAction.value,
  );
  const deleteDisabledReason = computed(() => {
    if (deployment.value || accepted.value)
      return "Deletion is unavailable after a deployment exists. Runtime cleanup is not available yet, even after Stop.";
    if (submitting.value || uncertain.value)
      return "Deletion is unavailable until the runtime request is confirmed.";
    if (!checked.value || statusError.value)
      return "Deletion is unavailable until runtime status can be checked.";
    return "";
  });

  function stopObserving() {
    clearTimeout(timer);
    observer?.abort();
  }

  async function check(signal: AbortSignal) {
    try {
      const next = await client.deployment(id, signal);
      const nextOperation = next
        ? await client.operation(next.operationId, signal)
        : null;
      signal.throwIfAborted();
      if (
        (next && next.configId !== id) ||
        (nextOperation &&
          (nextOperation.configId !== id ||
            nextOperation.id !== next?.operationId))
      )
        throw new Error("Runtime status does not match the request");
      if (accepted.value && next?.operationId !== accepted.value.id) {
        // Another tab may have submitted a newer operation before this poll.
        const submitted = await client.operation(accepted.value.id, signal);
        signal.throwIfAborted();
        if (
          submitted.id !== accepted.value.id ||
          submitted.configId !== id ||
          active(submitted)
        )
          throw new Error("The submitted operation is not yet reflected");
        accepted.value = null;
      }
      deployment.value = next;
      operation.value = nextOperation;
      checked.value = true;
      statusError.value = "";
      failures = 0;
      if (accepted.value && !active(nextOperation)) accepted.value = null;
      if (
        retry &&
        nextOperation?.type === retry.type &&
        nextOperation.id !== retry.previousOperationId
      ) {
        retry = undefined;
        uncertain.value = false;
        actionError.value = "";
      }
    } catch (error) {
      if (signal.aborted) return;
      statusError.value =
        "Could not check runtime status. Actions are paused until status is available.";
      if (
        error instanceof AuthError &&
        error.status > 0 &&
        error.status < 500 &&
        error.status !== 429
      )
        return;
      failures += 1;
    }
    if (
      !signal.aborted &&
      (pendingAction.value ||
        deployment.value?.state === "starting" ||
        deployment.value?.state === "stopping" ||
        uncertain.value ||
        statusError.value)
    )
      timer = setTimeout(
        () => void check(signal),
        Math.min(30000, 2000 * 2 ** Math.min(failures, 4)),
      );
  }

  function refresh() {
    if (disposed || submitting.value) return;
    stopObserving();
    observer = new AbortController();
    void check(observer.signal);
  }

  async function submit(type: Action, revisionId?: string) {
    if (!canAct.value || (type === "start" && !revisionId)) return;
    stopObserving();
    submitting.value = type;
    actionError.value = "";
    if (retry?.type !== type || retry.revisionId !== revisionId)
      retry = {
        type,
        revisionId,
        key: crypto.randomUUID(),
        previousOperationId: deployment.value?.operationId,
      };
    command = new AbortController();
    const signal = command.signal;
    try {
      const result = await client.submit(
        id,
        type,
        revisionId,
        retry.key,
        signal,
      );
      signal.throwIfAborted();
      accepted.value = { id: result.operationId, type };
      retry = undefined;
      uncertain.value = false;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AuthError && error.status === 409) {
        actionError.value =
          "The request conflicts with a pending operation, running configuration, or reserved port. Check status and try again; only one configuration can run per account.";
      } else if (error instanceof AuthError && error.status === 400) {
        actionError.value =
          "This saved revision could not be used for the runtime action. Refresh the configuration before trying again.";
      } else {
        uncertain.value =
          !(error instanceof AuthError) ||
          error.status === 0 ||
          error.status >= 500;
        actionError.value = `Could not confirm ${type === "start" ? "Start" : "Stop"}. Check status, then retry this action.`;
      }
    } finally {
      submitting.value = null;
      if (!disposed) refresh();
    }
  }

  onScopeDispose(() => {
    disposed = true;
    stopObserving();
    command?.abort();
  });

  return {
    state,
    operation,
    checked,
    pendingAction,
    canAct,
    statusError,
    actionError,
    deleteDisabledReason,
    refresh,
    submit,
  };
}
