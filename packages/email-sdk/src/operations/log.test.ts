import { describe, expect, it } from "vitest";
import {
  createLogEntry,
  generateLogEntryId,
  operationLogEntrySchema,
  type CreateLogEntryInput,
} from "./log";
import type { Operation } from "./ops";

const sampleOp: Operation = { name: "removeBlock", blockId: "sec_a1b2" };
const sampleInverse: Operation = {
  name: "restoreBlocks",
  blocks: [{ id: "sec_a1b2", type: "section", parentId: "root", childrenIds: [], properties: {} }],
  parentId: "root",
  index: 0,
};

const baseInput: CreateLogEntryInput = {
  op: sampleOp,
  inverse: sampleInverse,
  authorId: "user_123",
  author: "user",
};

describe("generateLogEntryId", () => {
  it("produces ids of the form ople_<8 lowercase alphanumeric>", () => {
    expect(generateLogEntryId()).toMatch(/^ople_[a-z0-9]{8}$/);
  });

  it("is deterministic under an injected random function", () => {
    expect(generateLogEntryId(() => 0)).toBe("ople_aaaaaaaa");
  });
});

describe("createLogEntry", () => {
  it("fills in a generated id and a current timestamp by default", () => {
    const beforeMs = Date.now();
    const entry = createLogEntry(baseInput);
    expect(entry.id).toMatch(/^ople_[a-z0-9]{8}$/);
    expect(entry.timestamp).toBeGreaterThanOrEqual(beforeMs);
    expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
    expect(entry.op).toEqual(sampleOp);
    expect(entry.inverse).toEqual(sampleInverse);
    expect(entry.authorId).toBe("user_123");
    expect(entry.author).toBe("user");
  });

  it("omits batchId when not provided and includes it when given", () => {
    expect(createLogEntry(baseInput)).not.toHaveProperty("batchId");
    expect(createLogEntry({ ...baseInput, batchId: "batch_1" }).batchId).toBe("batch_1");
  });

  it("respects explicit id and timestamp overrides", () => {
    const entry = createLogEntry({
      ...baseInput,
      author: "agent",
      authorId: "agent_thread_9",
      id: "ople_fixed001",
      timestamp: 1700000000000,
    });
    expect(entry.id).toBe("ople_fixed001");
    expect(entry.timestamp).toBe(1700000000000);
    expect(entry.author).toBe("agent");
  });

  it("produces entries that pass the log entry schema (with and without batchId)", () => {
    expect(operationLogEntrySchema.safeParse(createLogEntry(baseInput)).success).toBe(true);
    expect(
      operationLogEntrySchema.safeParse(createLogEntry({ ...baseInput, batchId: "batch_2" }))
        .success,
    ).toBe(true);
  });
});

describe("operationLogEntrySchema", () => {
  it("rejects unknown keys and invalid authors", () => {
    const validEntry = createLogEntry(baseInput);
    expect(operationLogEntrySchema.safeParse({ ...validEntry, extra: 1 }).success).toBe(false);
    expect(operationLogEntrySchema.safeParse({ ...validEntry, author: "system" }).success).toBe(
      false,
    );
  });
});
