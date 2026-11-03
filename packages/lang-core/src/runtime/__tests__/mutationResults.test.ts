import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryManager, type ToolProvider } from "../queryManager";
import { ToolNotFoundError } from "../toolProvider";

const save = { statementId: "save", toolName: "save_item" };

afterEach(() => vi.restoreAllMocks());

describe("QueryManager mutation results from outside", () => {
  it("setMutationResult mirrors a result without calling the tool", () => {
    const callTool = vi.fn();
    const qm = createQueryManager({ callTool } as ToolProvider);
    qm.registerMutations([save]);
    const listener = vi.fn();
    qm.subscribe(listener);

    qm.setMutationResult("save", { status: "success", data: { id: 1 } });

    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: { id: 1 } });
    expect(qm.getSnapshot().save).toEqual({ status: "success", data: { id: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not notify when the same result is set again", () => {
    const qm = createQueryManager({ callTool: vi.fn() } as ToolProvider);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "error", error: "nope" });
    const listener = vi.fn();
    qm.subscribe(listener);
    qm.setMutationResult("save", { status: "error", error: "nope" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps a result for a mutation that registers later (still streaming)", () => {
    const qm = createQueryManager({ callTool: vi.fn() } as ToolProvider);
    qm.setMutationResult("save", { status: "success" });
    expect(qm.getMutationResult("save")).toBeNull();
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")).toEqual({ status: "success" });
  });

  it("onMutationResult reports loading and success of a fired mutation", async () => {
    const onMutationResult = vi.fn();
    const qm = createQueryManager({ callTool: vi.fn().mockResolvedValue("ok") } as ToolProvider, {
      onMutationResult,
    });
    qm.registerMutations([save]);
    await qm.fireMutation("save", {});
    expect(onMutationResult.mock.calls).toEqual([
      ["save", { status: "loading" }],
      ["save", { status: "success", data: "ok" }],
    ]);
  });

  it("onMutationResult reports errors", async () => {
    const onMutationResult = vi.fn();
    const qm = createQueryManager(
      { callTool: vi.fn().mockRejectedValue(new Error("Betrag fehlt")) } as ToolProvider,
      {
        onMutationResult,
      },
    );
    qm.registerMutations([save]);
    await qm.fireMutation("save", {});
    expect(onMutationResult).toHaveBeenLastCalledWith("save", {
      status: "error",
      error: "Betrag fehlt",
    });
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("QueryManager mutation results: precedence and recovery", () => {
  it("a local call in flight settles last and keeps the double-submit guard; other mutations stay valid", async () => {
    const local = deferred<string>();
    const callTool = vi.fn((name: string) =>
      name === "save_item" ? local.promise : Promise.resolve("other-ok"),
    );
    const qm = createQueryManager({ callTool } as ToolProvider);
    qm.registerMutations([save, { statementId: "other", toolName: "other_tool" }]);
    const first = qm.fireMutation("save", {});
    qm.setMutationResult("save", { status: "success", data: "remote" });
    expect(qm.getMutationResult("save")?.status).toBe("loading");
    expect(await qm.fireMutation("save", {})).toBe(false);
    expect(await qm.fireMutation("other", {})).toBe(true);
    local.resolve("local");
    expect(await first).toBe(true);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "local" });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("a restored loading result is display only and does not block a new call", async () => {
    const qm = createQueryManager({ callTool: vi.fn().mockResolvedValue("ok") } as ToolProvider);
    qm.setMutationResult("save", { status: "loading" });
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")?.status).toBe("loading");
    expect(await qm.fireMutation("save", {})).toBe(true);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "ok" });
  });

  it("a throwing onMutationResult does not stop the tool or lock the mutation", async () => {
    const callTool = vi.fn().mockResolvedValue("ok");
    const fehler = vi.spyOn(console, "error").mockImplementation(() => {});
    const qm = createQueryManager({ callTool } as ToolProvider, {
      onMutationResult: () => {
        throw new Error("storage full");
      },
    });
    qm.registerMutations([save]);
    expect(await qm.fireMutation("save", {})).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "ok" });
    expect(await qm.fireMutation("save", {})).toBe(true);
    fehler.mockRestore();
  });

  it("an imported error replaces the diagnostic of an earlier local failure", async () => {
    const qm = createQueryManager({
      callTool: vi.fn().mockRejectedValue(new Error("old error")),
    } as ToolProvider);
    qm.registerMutations([save]);
    await qm.fireMutation("save", {});
    qm.setMutationResult("save", { status: "error", error: "remote error" });
    expect(qm.getSnapshot().save).toEqual({ status: "error", error: "remote error" });
    expect(qm.getSnapshot().__openui_errors.map((e) => e.message)).toEqual([
      'Mutation "save_item" failed: remote error',
    ]);
  });

  it("equality follows the published JSON snapshot: equivalent imports do not notify, changes do", () => {
    const qm = createQueryManager({ callTool: vi.fn() } as ToolProvider);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "error", error: { message: "first" } });
    const listener = vi.fn();
    qm.subscribe(listener);
    const before = qm.getSnapshot();
    qm.setMutationResult(
      "save",
      JSON.parse(JSON.stringify({ status: "error", error: { message: "first" } })),
    );
    expect(listener).not.toHaveBeenCalled();
    qm.setMutationResult("save", { status: "error", error: { message: "second" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(qm.getSnapshot()).not.toBe(before);
    expect((qm.getSnapshot().save as { error: { message: string } }).error.message).toBe("second");
    expect((qm.getMutationResult("save")?.error as { message: string }).message).toBe("second");
  });

  it("the last known result survives dispose and re-registration; a reused statement with another tool resets", () => {
    const qm = createQueryManager({ callTool: vi.fn() } as ToolProvider);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "success", data: "kept" });
    qm.dispose();
    qm.activate();
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "kept" });
    qm.registerMutations([{ statementId: "save", toolName: "delete_item" }]);
    expect(qm.getMutationResult("save")?.status).toBe("idle");
  });

  it("an old completion after dispose/activate is ignored (lifecycle guard)", async () => {
    const local = deferred<string>();
    const qm = createQueryManager({ callTool: vi.fn(() => local.promise) } as ToolProvider);
    qm.registerMutations([save]);
    const first = qm.fireMutation("save", {});
    qm.dispose();
    qm.activate();
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "success", data: "restored" });
    local.resolve("stale");
    expect(await first).toBe(false);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "restored" });
  });
});

describe("QueryManager mutation lifecycle", () => {
  it.each(["remove", "dispose"])("retains tool identity after %s", (detach) => {
    const qm = createQueryManager(null);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "success", data: "saved" });
    if (detach === "remove") qm.registerMutations([]);
    else {
      qm.dispose();
      qm.activate();
    }
    qm.registerMutations([{ statementId: "save", toolName: "delete_item" }]);
    expect(qm.getMutationResult("save")).toEqual({ status: "idle" });
    expect(qm.getSnapshot().save).toBe(qm.getMutationResult("save"));
  });

  it("re-registration preserves an active invocation and its submission guard", async () => {
    const local = deferred<string>();
    const callTool = vi.fn(() => local.promise);
    const qm = createQueryManager({ callTool });
    qm.registerMutations([save]);
    const running = qm.fireMutation("save", {});
    const snapshot = qm.getSnapshot();
    const listener = vi.fn();
    qm.subscribe(listener);
    qm.registerMutations([save]);
    expect(qm.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    expect(await qm.fireMutation("save", {})).toBe(false);
    local.resolve("ok");
    expect(await running).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it.each(["remove", "dispose"])("drops transient local loading after %s", async (detach) => {
    const local = deferred<string>();
    const onMutationResult = vi.fn();
    const qm = createQueryManager({ callTool: () => local.promise }, { onMutationResult });
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "success", data: "restored" });
    const running = qm.fireMutation("save", {});
    if (detach === "remove") qm.registerMutations([]);
    else qm.dispose();
    expect(qm.getMutationResult("save")).toBeNull();
    expect(qm.getSnapshot().save).toBeUndefined();
    qm.activate();
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "restored" });
    local.resolve("stale");
    expect(await running).toBe(false);
    expect(qm.getMutationResult("save")?.data).toBe("restored");
    expect(onMutationResult.mock.calls).toEqual([["save", { status: "loading" }]]);
  });

  it.each(["success", "error"])("ignores stale %s after a tool change", async (status) => {
    let settle!: () => void;
    const old = new Promise<string>((resolve, reject) => {
      settle = () => (status === "success" ? resolve("stale") : reject(new Error("stale")));
    });
    const callTool = vi.fn((name: string) =>
      name === "save_item" ? old : Promise.resolve("deleted"),
    );
    const onMutationResult = vi.fn();
    const qm = createQueryManager({ callTool }, { onMutationResult });
    qm.registerMutations([save]);
    const running = qm.fireMutation("save", {});
    qm.registerMutations([{ statementId: "save", toolName: "delete_item" }]);
    expect(await qm.fireMutation("save", {})).toBe(true);
    settle();
    expect(await running).toBe(false);
    expect(qm.getMutationResult("save")).toEqual({ status: "success", data: "deleted" });
    expect(onMutationResult.mock.calls).toEqual([
      ["save", { status: "loading" }],
      ["save", { status: "loading" }],
      ["save", { status: "success", data: "deleted" }],
    ]);
  });

  it("does not call a tool when its loading observer detaches the manager", async () => {
    const callTool = vi.fn().mockResolvedValue("unexpected");
    const qm = createQueryManager({ callTool }, { onMutationResult: () => qm.dispose() });
    qm.registerMutations([save]);
    expect(await qm.fireMutation("save", {})).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    qm.activate();
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")).toEqual({ status: "idle" });
  });

  it("reports the local event even if a subscriber replaces the displayed result", async () => {
    const onMutationResult = vi.fn();
    const qm = createQueryManager(
      { callTool: vi.fn().mockResolvedValue("local") },
      { onMutationResult },
    );
    qm.registerMutations([save]);
    qm.subscribe(() => {
      if (qm.getMutationResult("save")?.data === "local")
        qm.setMutationResult("save", { status: "success", data: "remote" });
    });
    expect(await qm.fireMutation("save", {})).toBe(true);
    expect(onMutationResult.mock.calls).toEqual([
      ["save", { status: "loading" }],
      ["save", { status: "success", data: "local" }],
    ]);
    expect(qm.getMutationResult("save")?.data).toBe("remote");
  });

  it("observer failures do not skip query refresh or alter the mutation outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const callTool = vi.fn().mockResolvedValue("ok");
    const qm = createQueryManager(
      { callTool },
      {
        onMutationResult: () => {
          throw new Error("storage full");
        },
      },
    );
    qm.evaluateQueries([
      {
        statementId: "items",
        toolName: "list_items",
        args: {},
        defaults: [],
        deps: null,
        complete: true,
      },
    ]);
    await Promise.resolve();
    qm.registerMutations([save]);
    expect(await qm.fireMutation("save", {}, ["items"])).toBe(true);
    expect(callTool.mock.calls.map(([name]) => name)).toEqual([
      "list_items",
      "save_item",
      "list_items",
    ]);
  });

  it("retains structured local failures across detach and clears them during retry", async () => {
    const failure = new ToolNotFoundError("save_item", ["other_tool"]);
    const callTool = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("ok");
    const qm = createQueryManager({ callTool });
    qm.registerMutations([save]);
    await qm.fireMutation("save", {});
    const diagnostic = qm.getSnapshot().__openui_errors[0];
    expect(diagnostic.code).toBe("tool-not-found");
    qm.dispose();
    qm.activate();
    qm.registerMutations([save]);
    expect(qm.getSnapshot().__openui_errors).toEqual([diagnostic]);
    const retry = qm.fireMutation("save", {});
    expect(qm.getSnapshot().__openui_errors).toEqual([]);
    expect(await retry).toBe(true);
  });

  it("publishes distinct Error payloads consistently instead of comparing their JSON", () => {
    const qm = createQueryManager(null);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "error", error: new Error("first") });
    const before = qm.getSnapshot();
    const listener = vi.fn();
    qm.subscribe(listener);
    const error = new Error("second");
    qm.setMutationResult("save", { status: "error", error });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(qm.getSnapshot()).not.toBe(before);
    expect(qm.getSnapshot().save).toBe(qm.getMutationResult("save"));
    expect(qm.getMutationResult("save")?.error).toBe(error);
    expect(qm.getSnapshot().__openui_errors[0].message).toContain("second");
  });

  it("accepts cyclic and bigint payloads and ignores an equal re-supply", () => {
    const qm = createQueryManager(null);
    qm.registerMutations([save]);
    const payload: { count: bigint; self?: unknown } = { count: 1n };
    payload.self = payload;
    qm.setMutationResult("save", { status: "success", data: payload });
    const before = qm.getSnapshot();
    expect(before.save).toBe(qm.getMutationResult("save"));
    const listener = vi.fn();
    qm.subscribe(listener);
    qm.setMutationResult("save", { status: "success", data: payload });
    expect(qm.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a value equal to the last supplied one even after a local completion", async () => {
    const qm = createQueryManager({
      callTool: vi.fn().mockResolvedValue("new"),
    } as ToolProvider);
    qm.registerMutations([save]);
    qm.setMutationResult("save", { status: "success", data: "old" });
    await qm.fireMutation("save", {});
    expect(qm.getMutationResult("save")?.data).toBe("new");
    qm.setMutationResult("save", { status: "success", data: "old" });
    expect(qm.getMutationResult("save")?.data).toBe("new");
    qm.setMutationResult("save", { status: "success", data: "older" });
    expect(qm.getMutationResult("save")?.data).toBe("older");
  });

  it("copies a pending result's envelope before later registration", () => {
    const qm = createQueryManager(null);
    const supplied = { status: "success" as const, data: "restored" };
    qm.setMutationResult("save", supplied);
    supplied.data = "changed";
    qm.registerMutations([save]);
    expect(qm.getMutationResult("save")?.data).toBe("restored");
  });
});
