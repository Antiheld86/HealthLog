import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const useAuthMock = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => useAuthMock(),
}));
const hasClientMock = vi.fn(() => true);
vi.mock("@/hooks/_internal/use-query-client-safe", () => ({
  useQueryClientMounted: () => hasClientMock(),
}));

import { useSurfaceVisible } from "../use-surface-visible";

function Probe({ id }: { id: string }) {
  return <span>{String(useSurfaceVisible(id))}</span>;
}

const visible = (id: string) =>
  renderToStaticMarkup(<Probe id={id} />).includes(">true<");

describe("useSurfaceVisible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasClientMock.mockReturnValue(true);
  });

  it("hides a surface whose module the record switched off", () => {
    useAuthMock.mockReturnValue({ user: { modules: { mood: false } } });
    expect(visible("capture:mood")).toBe(false);
    expect(visible("capture:medication")).toBe(true);
  });

  it("is on before the account resolves", () => {
    useAuthMock.mockReturnValue({ user: null });
    expect(visible("capture:mood")).toBe(true);
  });

  it("is on without a query client, and never reads the account then", () => {
    hasClientMock.mockReturnValue(false);
    expect(visible("capture:mood")).toBe(true);
    expect(useAuthMock).not.toHaveBeenCalled();
  });
});
