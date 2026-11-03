// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { type MutationResult, tagSchemaId, useTriggerAction } from "./index";
import { createLibrary, defineComponent } from "./library";
import { Renderer } from "./Renderer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Text = defineComponent({
  name: "Text",
  description: "Text",
  props: z.object({ text: z.string() }),
  component: ({ props }) => <p>{props.text}</p>,
});
const Stack = defineComponent({
  name: "Stack",
  description: "Stack",
  props: z.object({ children: z.array(Text.ref) }),
  component: ({ props, renderNode }) => <div>{renderNode(props.children)}</div>,
});
const library = createLibrary({ components: [Stack, Text], root: "Stack" });

const program = `root = Stack([status])
save = Mutation("save_item", {})
status = Text(save.status == "success" ? "Saved" : save.status == "error" ? "Failed: " + save.error : "Idle")`;

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

async function render(el: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(el));
  return { container, root };
}

it("mutationResults mirrors a result produced elsewhere, without calling the tool", async () => {
  const save_item = vi.fn();
  const { container, root } = await render(
    <Renderer
      response={program}
      library={library}
      toolProvider={{ save_item }}
      mutationResults={{ save: { status: "idle" } }}
    />,
  );
  expect(container.textContent).toBe("Idle");
  await act(async () =>
    root.render(
      <Renderer
        response={program}
        library={library}
        toolProvider={{ save_item }}
        mutationResults={{ save: { status: "success" } }}
      />,
    ),
  );
  expect(container.textContent).toBe("Saved");
  await act(async () =>
    root.render(
      <Renderer
        response={program}
        library={library}
        toolProvider={{ save_item }}
        mutationResults={{ save: { status: "error", error: "no amount" } }}
      />,
    ),
  );
  expect(container.textContent).toBe("Failed: no amount");
  expect(save_item).not.toHaveBeenCalled();
});

it("mutationResults restores a persisted result on mount", async () => {
  const { container } = await render(
    <Renderer
      response={program}
      library={library}
      toolProvider={{ save_item: vi.fn() }}
      mutationResults={{ save: { status: "success" } }}
    />,
  );
  expect(container.textContent).toBe("Saved");
});

// ─── Regressions: precedence with a pending call, restored loading ───

const actionExpression = z.any();
tagSchemaId(actionExpression, "ActionExpression");
const Go = defineComponent({
  name: "Go",
  description: "Button",
  props: z.object({ label: z.string(), action: actionExpression.optional() }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    return createElement(
      "button",
      { onClick: () => trigger(props.label, undefined, props.action) },
      props.label,
    );
  },
});
const Box = defineComponent({
  name: "Box",
  description: "Box",
  props: z.object({ children: z.array(z.union([Text.ref, Go.ref])) }),
  component: ({ props, renderNode }) => <div>{renderNode(props.children)}</div>,
});
const lib2 = createLibrary({ components: [Box, Text, Go], root: "Box" });
const prog2 = `root = Box([go, status])
save = Mutation("save_item", {})
go = Go("Go", @Run(save))
status = Text(save.status == "success" ? "Saved:" + save.data : save.status == "loading" ? "Loading" : "Idle")`;

it("an unchanged restored map does not replay over a pending call when the response re-parses", async () => {
  let resolve!: (v: unknown) => void;
  const save_item = vi.fn(() => new Promise((r) => (resolve = r)));
  const restored = { save: { status: "success" as const, data: "old" } };
  const { container, root } = await render(
    <Renderer
      response={prog2}
      library={lib2}
      toolProvider={{ save_item }}
      mutationResults={restored}
    />,
  );
  expect(container.textContent).toContain("Saved:old");
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain("Loading");
  await act(async () =>
    root.render(
      <Renderer
        response={prog2 + '\nextra = Text("x")'}
        library={lib2}
        toolProvider={{ save_item }}
        mutationResults={restored}
      />,
    ),
  );
  expect(container.textContent).toContain("Loading");
  await act(async () => resolve("new"));
  expect(container.textContent).toContain("Saved:new");
});

it("a persisted loading result can be recovered by clicking again", async () => {
  const save_item = vi.fn().mockResolvedValue("ok");
  const { container } = await render(
    <Renderer
      response={prog2}
      library={lib2}
      toolProvider={{ save_item }}
      mutationResults={{ save: { status: "loading" } }}
    />,
  );
  expect(container.textContent).toContain("Loading");
  await act(async () => container.querySelector("button")?.click());
  expect(save_item).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Saved:ok");
});

it("restores through StrictMode and registers results supplied while streaming", async () => {
  const save_item = vi.fn();
  const restored = { save: { status: "success" as const, data: "restored" } };
  const props = {
    response: prog2,
    library: lib2,
    toolProvider: { save_item },
    mutationResults: restored,
  };
  const { container, root } = await render(
    <StrictMode>
      <Renderer {...props} isStreaming />
    </StrictMode>,
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <Renderer {...props} />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toContain("Saved:restored");
  expect(save_item).not.toHaveBeenCalled();
});

it("unchanged supplied values never replay after a local completion, including cloned maps", async () => {
  const save_item = vi.fn().mockResolvedValue("new");
  const props = { response: prog2, library: lib2, toolProvider: { save_item } };
  const restored = { save: { status: "success" as const, data: "old" } };
  const { container, root } = await render(<Renderer {...props} mutationResults={restored} />);
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain("Saved:new");
  await act(async () =>
    root.render(
      <Renderer
        {...props}
        response={prog2 + '\nextra = Text("x")'}
        mutationResults={{ save: { ...restored.save } }}
      />,
    ),
  );
  expect(container.textContent).toContain("Saved:new");
});

it("ignores a removed and reintroduced unchanged value; a changed value applies", async () => {
  const props = {
    response: prog2,
    library: lib2,
    toolProvider: { save_item: vi.fn().mockResolvedValue("new") },
  };
  const restored = { save: { status: "success" as const, data: "old" } };
  const { container, root } = await render(<Renderer {...props} mutationResults={restored} />);
  await act(async () => container.querySelector("button")?.click());
  await act(async () => root.render(<Renderer {...props} />));
  expect(container.textContent).toContain("Saved:new");
  await act(async () => root.render(<Renderer {...props} mutationResults={restored} />));
  expect(container.textContent).toContain("Saved:new");
  await act(async () =>
    root.render(
      <Renderer {...props} mutationResults={{ save: { status: "success", data: "older" } }} />,
    ),
  );
  expect(container.textContent).toContain("Saved:older");
});

it("resets a restored result when its statement changes to another tool", async () => {
  const restored = { save: { status: "success" as const, data: "old" } };
  const props = { response: prog2, library: lib2, mutationResults: restored };
  const { container, root } = await render(<Renderer {...props} />);
  await act(async () =>
    root.render(
      <Renderer
        {...props}
        response={prog2.replace('Mutation("save_item"', 'Mutation("delete_item"')}
      />,
    ),
  );
  expect(container.textContent).toContain("Idle");
  expect(container.textContent).not.toContain("Saved:old");
});

it("mirrors Error payload changes in both rendered content and onError", async () => {
  const response = `root = Stack([status])
save = Mutation("save_item", {})
status = Text(save.status == "error" ? save.error.message : "Idle")`;
  const onError = vi.fn();
  const props = { response, library, onError };
  const { container, root } = await render(
    <Renderer
      {...props}
      mutationResults={{ save: { status: "error", error: new Error("first") } }}
    />,
  );
  expect(container.textContent).toBe("first");
  await act(async () =>
    root.render(
      <Renderer
        {...props}
        mutationResults={{ save: { status: "error", error: new Error("second") } }}
      />,
    ),
  );
  expect(container.textContent).toBe("second");
  expect(onError.mock.lastCall?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "mutation",
        message: 'Mutation "save_item" failed: second',
      }),
    ]),
  );
});

it("observer failures do not abort subsequent action steps and the latest callback is used", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onAction = vi.fn();
  const previous = vi.fn();
  const next = vi.fn((_id: string, _result: MutationResult) => {
    throw new Error("storage full");
  });
  const save_item = vi.fn().mockResolvedValue("ok");
  const response = prog2.replace(
    "@Run(save)",
    'Action([@Run(save), @OpenUrl("https://example.com")])',
  );
  const props = { response, library: lib2, toolProvider: { save_item }, onAction };
  const { container, root } = await render(<Renderer {...props} onMutationResult={previous} />);
  await act(async () => root.render(<Renderer {...props} onMutationResult={next} />));
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain("Saved:ok");
  expect(previous).not.toHaveBeenCalled();
  expect(next.mock.calls.map(([, result]) => result.status)).toEqual(["loading", "success"]);
  expect(onAction).toHaveBeenCalledWith(
    expect.objectContaining({ params: { url: "https://example.com" } }),
  );
});
