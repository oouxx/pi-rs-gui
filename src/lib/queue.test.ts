import { describe, expect, test } from "bun:test";
import { queuedFromQueueUpdate, removeQueuedChip } from "./queue";

describe("queuedFromQueueUpdate", () => {
  test("mirrors both queues, steering first", () => {
    expect(
      queuedFromQueueUpdate({
        steering: ["look at the failing test"],
        follow_up: ["then bump the version"],
      }),
    ).toEqual([
      { text: "look at the failing test", mode: "steer" },
      { text: "then bump the version", mode: "followUp" },
    ]);
  });

  test("an empty queue clears every chip", () => {
    expect(queuedFromQueueUpdate({ steering: [], follow_up: [] })).toEqual([]);
  });

  test("a single queue is independent of the other", () => {
    expect(queuedFromQueueUpdate({ steering: ["steer"] })).toEqual([
      { text: "steer", mode: "steer" },
    ]);
    expect(queuedFromQueueUpdate({ follow_up: ["later"] })).toEqual([
      { text: "later", mode: "followUp" },
    ]);
  });

  test("tolerates a malformed payload", () => {
    expect(queuedFromQueueUpdate(null)).toEqual([]);
    expect(queuedFromQueueUpdate(undefined)).toEqual([]);
    expect(queuedFromQueueUpdate({ steering: "not an array" })).toEqual([]);
    expect(queuedFromQueueUpdate({ steering: ["", 42, null] })).toEqual([]);
  });
});

describe("removeQueuedChip", () => {
  const chips = [
    { text: "first", mode: "steer" as const },
    { text: "second", mode: "followUp" as const },
  ];

  test("matches by prompt text", () => {
    expect(removeQueuedChip(chips, "first")).toEqual([chips[1]]);
  });

  test("falls back to the newest chip for a rewritten prompt", () => {
    // Attachment / template expansion changes the delivered text.
    expect(removeQueuedChip(chips, "expanded body")).toEqual([chips[0]]);
    expect(removeQueuedChip(chips)).toEqual([chips[0]]);
  });

  test("is a no-op on an empty queue", () => {
    expect(removeQueuedChip([], "first")).toEqual([]);
  });
});
