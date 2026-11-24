import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApiResource } from "../src/lib/useApiResource";

describe("useApiResource", () => {
  it("fetches data and clears the loading flag", async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: 1 });
    const { result } = renderHook(() => useApiResource(fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ id: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("captures the error message when the fetcher rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Boom"));
    const { result } = renderHook(() => useApiResource(fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Boom");
    expect(result.current.data).toBeNull();
  });

  it("does not fetch when disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue("data");
    const { result } = renderHook(() => useApiResource(fetcher, [], false));

    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it("starts fetching when enabled flips to true", async () => {
    const fetcher = vi.fn().mockResolvedValue("data");
    const { result, rerender } = renderHook(({ enabled }) => useApiResource(fetcher, [], enabled), {
      initialProps: { enabled: false },
    });
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe("data"));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refetches when reload is called", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const { result } = renderHook(() => useApiResource(fetcher));

    await waitFor(() => expect(result.current.data).toBe("first"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetches when a dependency changes", async () => {
    const fetcher = vi.fn(async (id: number) => `data-${id}`);
    const { result, rerender } = renderHook(({ id }) => useApiResource(() => fetcher(id), [id]), {
      initialProps: { id: 1 },
    });

    await waitFor(() => expect(result.current.data).toBe("data-1"));
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.data).toBe("data-2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the latest fetcher without refetching when only its identity changes", async () => {
    const first = vi.fn().mockResolvedValue("first");
    const second = vi.fn().mockResolvedValue("second");
    const { result, rerender } = renderHook(({ fetcher }) => useApiResource(fetcher), {
      initialProps: { fetcher: first },
    });

    await waitFor(() => expect(result.current.data).toBe("first"));
    rerender({ fetcher: second });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(second).toHaveBeenCalledOnce();
  });

  it("allows manual data overrides via setData", async () => {
    const fetcher = vi.fn().mockResolvedValue(0);
    const { result } = renderHook(() => useApiResource(fetcher));
    await waitFor(() => expect(result.current.data).toBe(0));

    act(() => result.current.setData((current: number | null) => (current ?? 0) + 5));
    expect(result.current.data).toBe(5);
  });

  it("ignores a pending result after unmount", async () => {
    let resolve: (value: string) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useApiResource(fetcher));

    expect(result.current.loading).toBe(true);
    unmount();
    await act(async () => resolve("late"));
    expect(result.current.data).toBeNull();
  });
});
