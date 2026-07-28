import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_MIN_VERSION,
  assertClaudeExecutableCompatible,
  isVersionBelowMin,
  parseClaudeVersion,
  type ClaudeVersionProbe,
} from "../adapters/claude/version.js";
import { ClaudeRuntimeAdapterError } from "../adapters/claude/errors.js";

describe("parseClaudeVersion", () => {
  it("parses a plain semver triple", () => {
    expect(parseClaudeVersion("2.1.191")).toEqual({
      major: 2,
      minor: 1,
      patch: 191,
      raw: "2.1.191",
    });
  });

  it("parses the first triple out of cli output with prefix and suffix", () => {
    expect(parseClaudeVersion("claude 2.1.220 (commit abcdef)")).toEqual({
      major: 2,
      minor: 1,
      patch: 220,
      raw: "2.1.220",
    });
  });

  it("returns null when no triple is present", () => {
    expect(parseClaudeVersion("garbage")).toBeNull();
    expect(parseClaudeVersion("2.1")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
    expect(parseClaudeVersion(undefined as unknown as string)).toBeNull();
  });
});

describe("isVersionBelowMin", () => {
  const at = (v: string) => parseClaudeVersion(v)!;

  it(`treats ${CLAUDE_MIN_VERSION} as the boundary`, () => {
    expect(isVersionBelowMin(at("2.1.191"))).toBe(false);
    expect(isVersionBelowMin(at("2.1.190"))).toBe(true);
  });

  it("passes versions above the minimum across all components", () => {
    expect(isVersionBelowMin(at("2.1.220"))).toBe(false);
    expect(isVersionBelowMin(at("2.2.0"))).toBe(false);
    expect(isVersionBelowMin(at("3.0.0"))).toBe(false);
  });

  it("rejects older versions across all components", () => {
    expect(isVersionBelowMin(at("2.1.0"))).toBe(true);
    expect(isVersionBelowMin(at("2.0.999"))).toBe(true);
    expect(isVersionBelowMin(at("1.9.999"))).toBe(true);
  });
});

const probe = (info: ClaudeVersionProbe["info"], raw = "", error: string | null = null) =>
  vi.fn().mockResolvedValue({ info, raw, error } as ClaudeVersionProbe);

const recordingLogger = () => {
  const calls = { debug: [] as unknown[], warn: [] as unknown[] };
  return {
    calls,
    logger: {
      debug: vi.fn((...args: unknown[]) => void calls.debug.push(args)),
      warn: vi.fn((...args: unknown[]) => void calls.warn.push(args)),
    },
  };
};

describe("assertClaudeExecutableCompatible", () => {
  beforeEach(() => {
    // Default to a non-test env so the DI-driven cases exercise the probe path;
    // individual skip tests override this.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: unknown }).__AIF_CLAUDE_QUERY_MOCK__;
  });

  it("throws a classified error when the binary is below the minimum", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.90"), "2.1.90");
    const { logger } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible("/bin/claude", logger, {}, { probeClaudeVersion: probeFn }),
    ).rejects.toMatchObject({
      name: "ClaudeRuntimeAdapterError",
      adapterCode: "CLAUDE_VERSION_UNSUPPORTED",
      category: "transport",
    });
    expect(probeFn).toHaveBeenCalledWith("/bin/claude");
  });

  it("includes the upgrade hint in the message", async () => {
    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probe(parseClaudeVersion("2.1.90")) },
      ),
    ).rejects.toThrow(/npm i -g @anthropic-ai\/claude-code@latest/);
  });

  it("does not throw and warns when the version cannot be determined", async () => {
    const probeFn = probe(null, "", "Claude executable not found: claude");
    const { logger, calls } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(undefined, logger, {}, { probeClaudeVersion: probeFn }),
    ).resolves.toBeUndefined();
    expect(calls.warn).toHaveLength(1);
    expect(calls.debug).toHaveLength(0);
  });

  it("does not throw and logs the version when at/above the minimum", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.220"), "2.1.220");
    const { logger, calls } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(undefined, logger, {}, { probeClaudeVersion: probeFn }),
    ).resolves.toBeUndefined();
    expect(calls.debug).toHaveLength(1);
    expect(calls.warn).toHaveLength(0);
  });

  it("is a no-op when AIF_CLAUDE_SKIP_VERSION_CHECK=1", async () => {
    vi.stubEnv("AIF_CLAUDE_SKIP_VERSION_CHECK", "1");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("is a no-op in unit tests (NODE_ENV=test without the integration flag)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("runs even under NODE_ENV=test when AIF_CLAUDE_INTEGRATION=1 (integration smoke)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "1");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).rejects.toThrow(/below the supported minimum/);
    expect(probeFn).toHaveBeenCalled();
  });

  it("is a no-op when the SDK query is mocked (unit tests)", async () => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: unknown }).__AIF_CLAUDE_QUERY_MOCK__ = () => {};
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("rejects a thrown error that is an instanceof ClaudeRuntimeAdapterError", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.190"));
    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).rejects.toBeInstanceOf(ClaudeRuntimeAdapterError);
  });
});
