// ─────────────────────────────────────────────────────────────────────────────
// Query Manager — reactive data fetching for openui-lang
// ─────────────────────────────────────────────────────────────────────────────

import type { OpenUIError } from "../parser/types";
import { McpToolError } from "./mcp";
import { ToolNotFoundError } from "./toolProvider";

/**
 * ToolProvider interface for Query() and Mutation() tool calls.
 * Framework-agnostic — works with MCP, REST, GraphQL, or any backend.
 *
 * @example
 * ```ts
 * // Function map (Renderer normalizes this automatically)
 * <Renderer toolProvider={{
 *   get_users: (args) => fetch(`/api/users`).then(r => r.json()),
 * }} />
 *
 * // MCP client (Renderer wraps extractToolResult automatically)
 * <Renderer toolProvider={mcpClient} />
 * ```
 */
export interface ToolProvider {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface QueryNode {
  statementId: string;
  toolName: string;
  args: unknown;
  defaults: unknown;
  /** Evaluated dependency value — included in cache key to force re-fetch on change. */
  deps: unknown;
  /** Auto-refresh interval in seconds. */
  refreshInterval?: number;
  complete: boolean;
}

export interface MutationNode {
  statementId: string;
  toolName: string;
}

export interface MutationResult {
  status: "idle" | "loading" | "success" | "error";
  data?: unknown;
  error?: unknown;
}

/** Compare immutable mutation payloads: plain objects/arrays by value, other objects by identity. */
function sameResult(a: MutationResult, b: MutationResult): boolean {
  const seen = new WeakMap<object, Set<object>>();
  function equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const prototype = Object.getPrototypeOf(a);
    if (prototype !== Object.getPrototypeOf(b)) return false;
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(a)) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    if (seen.get(a)?.has(b)) return true;
    const keys = Reflect.ownKeys(a);
    if (keys.length !== Reflect.ownKeys(b).length) return false;
    const pairs = seen.get(a) ?? new Set<object>();
    pairs.add(b);
    seen.set(a, pairs);
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        equal(Reflect.get(a, key), Reflect.get(b, key)),
    );
  }
  return a.status === b.status && equal(a.data, b.data) && equal(a.error, b.error);
}

export interface QuerySnapshot extends Record<string, unknown> {
  __openui_loading: string[];
  __openui_refetching: string[];
  __openui_errors: OpenUIError[];
}

export interface QueryManager {
  evaluateQueries(queryNodes: QueryNode[]): void;
  getResult(statementId: string): unknown;
  isLoading(statementId: string): boolean;
  isAnyLoading(): boolean;
  invalidate(statementIds?: string[]): void;
  registerMutations(nodes: MutationNode[]): void;
  fireMutation(
    statementId: string,
    evaluatedArgs: Record<string, unknown>,
    refreshQueryIds?: string[],
  ): Promise<boolean>;
  getMutationResult(statementId: string): MutationResult | null;
  /**
   * Set a mutation's result from outside, e.g. to restore it from persisted state or to mirror a
   * result produced elsewhere (another tab, a server). Does not call the tool.
   * - A result for a mutation that is not registered yet (still streaming) is applied on registration;
   *   the last known result also survives dispose/re-registration.
   * - A value equal to the last one supplied for the statement is ignored, so re-supplying an unchanged
   *   map never replays an old result over a newer local one.
   * - A call running in this manager settles last: an outside result does not release or overwrite it.
   * - A restored "loading" is display only and never blocks fireMutation.
   * - Payloads are immutable: plain objects/arrays compare by value, other objects by identity.
   *   Hosts are responsible for serialising payloads when persisting or transporting them.
   */
  setMutationResult(statementId: string, result: MutationResult): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): QuerySnapshot;
  activate(): void;
  dispose(): void;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface QueryEntry {
  toolName: string;
  args: unknown;
  defaults: unknown;
  cacheKey: string;
  prevCacheKey?: string;
  loading: boolean;
  everFetched: boolean;
  refreshInterval: number;
  timer?: ReturnType<typeof setInterval>;
  needsRefetch: boolean;
  error?: OpenUIError;
}

interface MutationEntry {
  /** Null until a result supplied during streaming is registered. Retained across detachments. */
  toolName: string | null;
  registered: boolean;
  /** Last external or settled local result. A local loading state is a transient overlay. */
  result: MutationResult;
  /** Last value passed to setMutationResult; an equal value is ignored. */
  supplied: MutationResult | null;
  error?: OpenUIError;
  /** Identity token invalidated on removal, tool change, or disposal. */
  inFlight: { result: MutationResult } | null;
}

interface CacheEntry {
  data: unknown;
  inFlight: boolean;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** JSON.stringify with stable key ordering at all nesting levels. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key: string, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as object).sort()) {
        sorted[k] = (val as any)[k];
      }
      return sorted;
    }
    // Serialize non-JSON-safe primitives to stable strings.
    // evaluate() can pull arbitrary values from store/ref state,
    // including undefined in object literals and edge-case numbers.
    if (val === undefined) return "__undefined__";
    if (typeof val === "number") {
      if (Number.isNaN(val)) return "__NaN__";
      if (val === Infinity) return "__Inf__";
      if (val === -Infinity) return "__-Inf__";
    }
    return val;
  });
}

function buildCacheKey(toolName: string, args: unknown, deps: unknown): string {
  const depsKey = deps != null ? "::" + stableStringify(deps) : "";
  return toolName + "::" + stableStringify(args) + depsKey;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface QueryManagerOptions {
  /** Reports local loading/success/error, never imported results. Observer exceptions are logged. */
  onMutationResult?: (statementId: string, result: MutationResult) => void;
}

function importedError(statementId: string, toolName: string, error: unknown): OpenUIError {
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else {
    try {
      message = JSON.stringify(error ?? null) ?? String(error);
    } catch {
      try {
        message = String(error);
      } catch {
        message = "Unknown error";
      }
    }
  }
  return {
    source: "mutation",
    code: "tool-error",
    message: `Mutation "${toolName}" failed: ${message}`,
    statementId,
    component: "Mutation",
    toolName,
  };
}

export function createQueryManager(
  toolProvider: ToolProvider | null,
  options: QueryManagerOptions = {},
): QueryManager {
  const report = (statementId: string, result: MutationResult) => {
    try {
      options.onMutationResult?.(statementId, result);
    } catch (err) {
      // An observer (e.g. persistence) must never change the mutation's outcome.
      console.error("[openui] onMutationResult threw", err);
    }
  };
  const queries = new Map<string, QueryEntry>();
  // One retained entry owns registration, the restorable result, and any local invocation.
  const mutations = new Map<string, MutationEntry>();
  const cache = new Map<string, CacheEntry>();
  const listeners = new Set<() => void>();

  let snapshot: QuerySnapshot = {
    __openui_loading: [],
    __openui_refetching: [],
    __openui_errors: [],
  };
  let snapshotJson = JSON.stringify(snapshot);
  let disposed = false;

  // ── Snapshot & notification ──────────────────────────────────────────────

  function rebuildSnapshot(): boolean {
    const out: QuerySnapshot = {
      __openui_loading: [],
      __openui_refetching: [],
      __openui_errors: [],
    };

    for (const [sid, q] of queries) {
      const entry = cache.get(q.cacheKey);
      if (entry && entry.data !== undefined) {
        // Use settled data (even while refetching — shows last good value)
        out[sid] = entry.data;
      } else if (q.prevCacheKey) {
        const prev = cache.get(q.prevCacheKey);
        if (prev && prev.data !== undefined) {
          out[sid] = prev.data;
        } else {
          out[sid] = q.defaults;
        }
      } else {
        out[sid] = q.defaults;
      }
      if (q.loading) {
        out.__openui_loading.push(sid);
        if (q.everFetched) out.__openui_refetching.push(sid);
      }
      if (q.error) out.__openui_errors.push(q.error);
    }

    for (const [sid, m] of mutations) {
      if (!m.registered) continue;
      out[sid] = m.inFlight?.result ?? m.result;
      if (!m.inFlight && m.error) out.__openui_errors.push(m.error);
    }

    try {
      const outJson = JSON.stringify(out);
      if (outJson === snapshotJson) return false;
      snapshot = out;
      snapshotJson = outJson;
    } catch {
      snapshot = out;
      snapshotJson = "";
    }
    return true;
  }

  function notify() {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  // ── Fetch execution ──────────────────────────────────────────────────────

  async function executeFetch(cacheKey: string, statementId: string) {
    if (!toolProvider) return;

    const q = queries.get(statementId);
    if (!q) return;

    // Capture the cache key at fetch start — if the query's key changes
    // while we're in-flight (deps changed), this fetch is stale.
    const fetchKey = cacheKey;
    const toolName = q.toolName;
    const args = q.args;

    // Mark in-flight — use undefined as "no data yet" sentinel (distinct from null)
    let entry = cache.get(fetchKey);
    if (!entry) {
      entry = { data: undefined, inFlight: true };
      cache.set(fetchKey, entry);
    } else {
      entry.inFlight = true;
    }
    q.loading = true;
    rebuildSnapshot();
    notify();

    try {
      const data = await toolProvider.callTool(toolName, (args as Record<string, unknown>) ?? {});
      if (disposed) return;
      // Query removed or moved to a different cache key while in-flight — discard
      const current = queries.get(statementId);
      if (!current || current.cacheKey !== fetchKey) {
        entry.inFlight = false;
        return;
      }

      entry.data = data ?? null;
      current.everFetched = true;
      current.error = undefined;

      // Clean up previous cache entry — clear prevCacheKey FIRST so
      // cleanupCacheEntry doesn't see this query as a live reference.
      if (current.prevCacheKey && current.prevCacheKey !== fetchKey) {
        const prevKey = current.prevCacheKey;
        current.prevCacheKey = undefined;
        cleanupCacheEntry(prevKey);
      }
    } catch (err) {
      // Only update error state if this fetch is still current
      const current = queries.get(statementId);
      if (current && current.cacheKey === fetchKey) {
        if (err instanceof ToolNotFoundError) {
          current.error = {
            source: "query",
            code: "tool-not-found",
            message: `Query tool "${toolName}" not found`,
            statementId,
            component: "Query",
            toolName,
            hint: err.availableTools.length
              ? `Available tools: ${err.availableTools.join(", ")}`
              : undefined,
          };
        } else if (err instanceof McpToolError) {
          current.error = {
            source: "query",
            code: "mcp-error",
            message: `Query "${toolName}" returned an error: ${err.toolErrorText}`,
            statementId,
            component: "Query",
            toolName,
          };
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          current.error = {
            source: "query",
            code: "tool-error",
            message: `Query "${toolName}" failed: ${msg}`,
            statementId,
            component: "Query",
            toolName,
          };
        }
      }
      console.error(`Query "${toolName}" failed:`, err);
    } finally {
      entry.inFlight = false;
      const current = queries.get(statementId);
      // Only clear loading if this fetch is still current
      if (current && current.cacheKey === fetchKey) {
        current.loading = false;
        if (rebuildSnapshot()) notify();
        // Re-fetch if invalidation occurred while in-flight
        if (current.needsRefetch) {
          current.needsRefetch = false;
          executeFetch(current.cacheKey, statementId);
        }
      } else {
        if (rebuildSnapshot()) notify();
      }
    }
  }

  /** Remove a cache entry if no query references it. */
  function cleanupCacheEntry(cacheKey: string) {
    for (const q of queries.values()) {
      if (q.cacheKey === cacheKey || q.prevCacheKey === cacheKey) return;
    }
    cache.delete(cacheKey);
  }

  // ── Query evaluation ─────────────────────────────────────────────────────

  function evaluateQueries(queryNodes: QueryNode[]) {
    if (disposed) return;

    const activeIds = new Set(queryNodes.map((n) => n.statementId));

    // Clean up removed queries
    for (const [sid, q] of queries) {
      if (!activeIds.has(sid)) {
        if (q.timer) clearInterval(q.timer);
        queries.delete(sid);
        // Clean up cache entries that are no longer referenced
        cleanupCacheEntry(q.cacheKey);
        if (q.prevCacheKey) cleanupCacheEntry(q.prevCacheKey);
      }
    }

    // Process active queries
    for (const node of queryNodes) {
      if (!node.complete) continue;

      const cacheKey = buildCacheKey(node.toolName, node.args, node.deps);
      const existing = queries.get(node.statementId);

      if (existing) {
        // Track previous cache key for fallback display
        if (existing.cacheKey !== cacheKey) {
          existing.prevCacheKey = existing.cacheKey;
        }
        existing.toolName = node.toolName;
        existing.args = node.args;
        existing.defaults = node.defaults;
        existing.cacheKey = cacheKey;
      } else {
        queries.set(node.statementId, {
          toolName: node.toolName,
          args: node.args,
          defaults: node.defaults,
          cacheKey,
          loading: false,
          everFetched: false,
          refreshInterval: 0,
          needsRefetch: false,
        });
      }

      const q = queries.get(node.statementId)!;

      // Fire fetch if no settled data and not already in-flight
      const entry = cache.get(cacheKey);
      const hasSettledData = entry && entry.data !== undefined && !entry.inFlight;
      if (toolProvider && !hasSettledData && !entry?.inFlight) {
        executeFetch(cacheKey, node.statementId);
      }

      // Configure auto-refresh timer
      const newInterval = node.refreshInterval ?? 0;
      if (newInterval !== q.refreshInterval) {
        if (q.timer) {
          clearInterval(q.timer);
          q.timer = undefined;
        }
        if (newInterval > 0) {
          q.timer = setInterval(() => {
            if (disposed || !toolProvider) return;
            const entry = cache.get(q.cacheKey);
            if (!entry?.inFlight) {
              executeFetch(q.cacheKey, node.statementId);
            }
          }, newInterval * 1000);
        }
        q.refreshInterval = newInterval;
      }
    }

    if (rebuildSnapshot()) notify();
  }

  // ── Query accessors ──────────────────────────────────────────────────────

  function getResult(statementId: string): unknown {
    const q = queries.get(statementId);
    if (!q) return null;
    const entry = cache.get(q.cacheKey);
    if (entry && entry.data !== undefined) return entry.data;
    // Fall back to previous cache entry while loading
    if (q.prevCacheKey) {
      const prev = cache.get(q.prevCacheKey);
      if (prev && prev.data !== undefined) return prev.data;
    }
    return q.defaults;
  }

  function isLoading(statementId: string): boolean {
    return queries.get(statementId)?.loading ?? false;
  }

  function isAnyLoading(): boolean {
    for (const q of queries.values()) {
      if (q.loading) return true;
    }
    return false;
  }

  function invalidate(statementIds?: string[]) {
    if (disposed || !toolProvider) return;

    const targets = statementIds?.length
      ? statementIds.filter((sid) => queries.has(sid))
      : [...queries.keys()];

    for (const sid of targets) {
      const q = queries.get(sid);
      if (!q) continue;
      const entry = cache.get(q.cacheKey);
      if (entry?.inFlight) {
        q.needsRefetch = true;
      } else {
        executeFetch(q.cacheKey, sid);
      }
    }
  }

  // ── Mutation methods ─────────────────────────────────────────────────────

  function publishMutations(localEvent?: { statementId: string; result: MutationResult }) {
    const changed = rebuildSnapshot();
    // Capture the event before observers/subscribers can re-enter and change the displayed result.
    if (localEvent) report(localEvent.statementId, localEvent.result);
    if (changed) notify();
  }

  function createMutationEntry(result: MutationResult = { status: "idle" }): MutationEntry {
    return { toolName: null, registered: false, result, supplied: null, inFlight: null };
  }

  function registerMutations(nodes: MutationNode[]) {
    if (disposed) return;
    const activeIds = new Set(nodes.map((n) => n.statementId));

    for (const [sid, m] of mutations) {
      if (!activeIds.has(sid)) {
        m.registered = false;
        m.inFlight = null;
      }
    }

    // Register/update active mutations
    for (const node of nodes) {
      let m = mutations.get(node.statementId);
      if (!m || (m.toolName !== null && m.toolName !== node.toolName)) {
        // Retain tool identity across removal/disposal so results never move to another tool.
        m = createMutationEntry();
        mutations.set(node.statementId, m);
      }
      if (m.toolName === null && m.result.status === "error")
        m.error = importedError(node.statementId, node.toolName, m.result.error);
      m.toolName = node.toolName;
      m.registered = true;
    }

    publishMutations();
  }

  async function fireMutation(
    statementId: string,
    evaluatedArgs: Record<string, unknown>,
    refreshQueryIds?: string[],
  ): Promise<boolean> {
    if (disposed || !toolProvider) return false;
    const m = mutations.get(statementId);
    if (!m?.registered || m.toolName === null) return false;

    // Reject concurrent calls on the same mutation — prevents double-submit. Only a call running in this
    // manager counts: a displayed "loading" restored from outside must not lock the mutation.
    if (m.inFlight !== null) return false;

    const toolName = m.toolName;
    const invocation = { result: { status: "loading" } as MutationResult };
    const isCurrent = () =>
      !disposed && m.registered && mutations.get(statementId) === m && m.inFlight === invocation;
    m.inFlight = invocation;

    publishMutations({ statementId, result: invocation.result });
    // A loading observer may have disposed the manager or changed the registered tool.
    if (!isCurrent()) return false;

    let success = false;
    try {
      const data = await toolProvider.callTool(toolName, evaluatedArgs);
      if (!isCurrent()) return false;
      m.inFlight = null;
      m.result = { status: "success", data };
      m.error = undefined;
      success = true;
    } catch (err) {
      if (!isCurrent()) return false;
      m.inFlight = null;
      const msg = err instanceof Error ? err.message : String(err);
      m.result = { status: "error", error: msg };
      if (err instanceof ToolNotFoundError) {
        m.error = {
          source: "mutation",
          code: "tool-not-found",
          message: `Mutation tool "${toolName}" not found`,
          statementId,
          component: "Mutation",
          toolName,
          hint: err.availableTools.length
            ? `Available tools: ${err.availableTools.join(", ")}`
            : undefined,
        };
      } else if (err instanceof McpToolError) {
        m.error = {
          source: "mutation",
          code: "mcp-error",
          message: `Mutation "${toolName}" returned an error: ${err.toolErrorText}`,
          statementId,
          component: "Mutation",
          toolName,
        };
      } else {
        m.error = {
          source: "mutation",
          code: "tool-error",
          message: `Mutation "${toolName}" failed: ${msg}`,
          statementId,
          component: "Mutation",
          toolName,
        };
      }
    }

    publishMutations({ statementId, result: m.result });

    if (success && refreshQueryIds?.length) {
      invalidate(refreshQueryIds);
    }

    return success;
  }

  function getMutationResult(statementId: string): MutationResult | null {
    const m = mutations.get(statementId);
    return m?.registered ? (m.inFlight?.result ?? m.result) : null;
  }

  function setMutationResult(statementId: string, result: MutationResult) {
    if (disposed) return;
    let m = mutations.get(statementId);
    if (m?.supplied && sameResult(m.supplied, result)) return;
    const supplied = { ...result };
    if (!m) {
      m = createMutationEntry(supplied);
      mutations.set(statementId, m);
    } else {
      m.result = supplied;
    }
    m.supplied = supplied;
    m.error =
      result.status === "error" && m.toolName !== null
        ? importedError(statementId, m.toolName, result.error)
        : undefined;
    // While a local call owns the display, retain this value only as its detachment fallback.
    if (m.registered) publishMutations();
  }

  // ── Pub/sub ──────────────────────────────────────────────────────────────

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getSnapshot(): QuerySnapshot {
    return snapshot;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function activate() {
    disposed = false;
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    // Clear timers and transient state, preserve cache + query entries for Strict Mode re-attach
    for (const q of queries.values()) {
      if (q.timer) {
        clearInterval(q.timer);
        q.timer = undefined;
      }
      q.refreshInterval = 0;
      q.loading = false;
      q.needsRefetch = false;
    }
    for (const m of mutations.values()) {
      m.registered = false;
      m.inFlight = null;
    }
    rebuildSnapshot();
  }

  return {
    evaluateQueries,
    getResult,
    isLoading,
    isAnyLoading,
    invalidate,
    registerMutations,
    fireMutation,
    getMutationResult,
    setMutationResult,
    subscribe,
    getSnapshot,
    activate,
    dispose,
  };
}
