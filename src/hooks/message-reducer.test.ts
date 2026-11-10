import { describe, expect, test } from "bun:test";
import {
  appendAssistantStep,
  applyDelta,
  applyDeltaBatch,
  blocksToText,
  extractText,
  replaceAssistantStep,
  toBlocks,
  transcriptToDisplay,
  type ContentBlock,
  type DisplayMessage,
  type StreamDelta,
} from "./message-reducer";

function assistantMessage(blocks: ContentBlock[]): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    content: blocksToText(blocks),
    blocks,
    createdAt: "",
  };
}

function delta(
  event_type: string,
  data: StreamDelta["data"],
  offset = 0,
): StreamDelta {
  return { event_type, data, offset };
}

describe("toBlocks / extractText", () => {
  test("keeps text, thinking, toolCall and image blocks", () => {
    const blocks = toBlocks([
      { type: "text", text: "hi" },
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
    expect(blocks.map((b) => b.type)).toEqual([
      "text",
      "thinking",
      "toolCall",
      "image",
    ]);
    expect(extractText([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "b" },
      { type: "text", text: "c" },
    ])).toBe("ac");
  });

  test("restores merged tool execution state from transcript reloads", () => {
    const [block] = toBlocks([
      {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: {},
        status: "success",
        result: "ok",
        isError: false,
      },
    ]);
    expect(block.status).toBe("success");
    expect(block.result).toBe("ok");
  });
});

describe("applyDelta", () => {
  test("appends text deltas to the last assistant bubble", () => {
    const prev = [assistantMessage([])];
    const next = applyDeltaBatch(prev, [
      delta("text_delta", { contentIndex: 0, delta: "hel" }),
      delta("text_delta", { contentIndex: 0, delta: "lo" }),
    ]);
    expect(next[0].blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(next[0].content).toBe("hello");
  });

  test("offsets deltas to the current step in a merged bubble", () => {
    const prev = [assistantMessage([{ type: "text", text: "step1" }])];
    const next = applyDelta(
      prev,
      delta("text_delta", { contentIndex: 0, delta: "step2" }, 1),
    );
    expect(next[0].blocks).toHaveLength(2);
    expect(next[0].blocks[1]).toEqual({ type: "text", text: "step2" });
    expect(next[0].content).toBe("step1step2");
  });

  test("accumulates tool-call arguments and finalizes the block", () => {
    let msgs = [assistantMessage([])];
    msgs = applyDelta(
      msgs,
      delta("toolcall_start", {
        contentIndex: 0,
        partial: { content: [{ type: "toolCall", id: "t1", name: "bash" }] },
      }),
    );
    msgs = applyDelta(msgs, delta("toolcall_delta", { contentIndex: 0, delta: '{"comm' }));
    msgs = applyDelta(msgs, delta("toolcall_delta", { contentIndex: 0, delta: 'and":"ls"}' }));
    msgs = applyDelta(
      msgs,
      delta("toolcall_end", {
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      }),
    );
    expect(msgs[0].blocks[0]).toMatchObject({
      type: "toolCall",
      id: "t1",
      name: "bash",
      arguments: { command: "ls" },
    });
  });

  test("ignores deltas when the last message is not an assistant", () => {
    const prev: DisplayMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "hi",
        blocks: [{ type: "text", text: "hi" }],
        createdAt: "",
      },
    ];
    expect(applyDelta(prev, delta("text_delta", { delta: "x" }))).toBe(prev);
  });
});

describe("appendAssistantStep", () => {
  test("merges a new step into the last assistant bubble", () => {
    const prev = [assistantMessage([{ type: "text", text: "a" }])];
    const { messages, stepOffset } = appendAssistantStep(
      prev,
      [{ type: "toolCall", id: "t1", name: "bash" }],
      "",
    );
    expect(messages).toHaveLength(1);
    expect(stepOffset).toBe(1);
    expect(messages[0].blocks.map((b) => b.type)).toEqual(["text", "toolCall"]);
    expect(messages[0].content).toBe("a");
  });

  test("starts a new bubble when the last message is not an assistant", () => {
    const prev: DisplayMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "hi",
        blocks: [{ type: "text", text: "hi" }],
        createdAt: "",
      },
    ];
    const { messages, stepOffset } = appendAssistantStep(
      prev,
      [{ type: "text", text: "yo" }],
      "yo",
    );
    expect(messages).toHaveLength(2);
    expect(stepOffset).toBe(0);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("yo");
  });
});

describe("replaceAssistantStep", () => {
  test("replaces only the current step and keeps earlier blocks", () => {
    const prev = [
      assistantMessage([
        { type: "toolCall", id: "t1", name: "bash" },
        { type: "text", text: "old" },
      ]),
    ];
    const next = replaceAssistantStep(prev, 1, [{ type: "text", text: "new" }]);
    expect(next[0].blocks[0]).toMatchObject({ type: "toolCall", id: "t1" });
    expect(next[0].blocks[1]).toEqual({ type: "text", text: "new" });
    expect(next[0].content).toBe("new");
  });

  test("keeps a previous error marker when the snapshot has none", () => {
    const prev = [{ ...assistantMessage([]), errorMessage: "boom" }];
    const next = replaceAssistantStep(prev, 0, [{ type: "text", text: "ok" }]);
    expect(next[0].errorMessage).toBe("boom");
  });
});

describe("transcriptToDisplay", () => {
  test("prefers structured blocks and tags the role", () => {
    const msgs = transcriptToDisplay([
      { id: "u1", kind: "message", role: "user", text: "hi", content: [{ type: "text", text: "hi" }] },
      { id: "a1", kind: "message", role: "assistant", text: "yo", content: [{ type: "text", text: "yo" }] },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].blocks[0]).toEqual({ type: "text", text: "yo" });
  });

  test("falls back to flattened text when content is absent", () => {
    const [msg] = transcriptToDisplay([{ role: "assistant", text: "plain" }]);
    expect(msg.blocks).toEqual([{ type: "text", text: "plain" }]);
    expect(msg.content).toBe("plain");
  });
});
