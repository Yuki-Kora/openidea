import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorRegistry } from "@/editor/api";
import { useProjectVcs } from "@/platform/projectVcs";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { PerforceToolWindow } from "../PerforceView";

describe("Perforce tool window interactions", () => {
  beforeEach(() => {
    useProjectVcs.setState({ root: "/project", choice: "perforce", provider: "perforce" });
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "p4_info") return Promise.resolve({ client: "ws", user: "dev", root: "/project", server: "p4:1666" });
      if (command === "p4_opened") return Promise.resolve([{ path: "/project/opened.ts", depot: "//depot/opened.ts", action: "edit", change: "default" }]);
      return Promise.resolve("");
    });
    useEditorRegistry.setState({ active: null } as never);
  });

  it("disables the Perforce panel after switching providers", () => {
    useProjectVcs.setState({ provider: "git" });
    render(<PerforceToolWindow />);
    expect(screen.getByText(/Select Perforce/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("checks out only the current editor file and disables checkout when no file is active", async () => {
    const view = render(<PerforceToolWindow />);
    const button = screen.getByRole("button", { name: "Check out current file" });
    expect(button).toBeDisabled();
    expect(screen.getByText("No file is active in the editor.")).toBeTruthy();

    useEditorRegistry.setState({ active: { ctx: { path: "/project/new.ts" } } } as never);
    view.rerender(<PerforceToolWindow />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Check out current file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Check out current file" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("p4_edit", { path: "/project/new.ts" }));
  });

  it("requires explicit file selection and confirms the exact default-changelist submission", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PerforceToolWindow />);
    await screen.findByText("opened.ts");
    expect(screen.getByText(/default changelist only/)).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "Include /project/opened.ts in submit" });
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("textbox", { name: "Submit description" }), { target: { value: "Change one file" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit selected files" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("/project/opened.ts"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Numbered changelists"));
    expect(invoke).not.toHaveBeenCalledWith("p4_submit", expect.anything());
    confirm.mockRestore();
  });

  it("renders IdeError.message rather than a generic object string", async () => {
    invoke.mockRejectedValueOnce({ message: "No Perforce connection" });
    render(<PerforceToolWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No Perforce connection");
  });

  it("clears the previous diff while changing files and never restores it after a failed diff", async () => {
    invoke.mockImplementation((command: string, args?: { path: string }) => {
      if (command === "p4_info") return Promise.resolve({ client: "ws", user: "dev", root: "/project", server: "p4:1666" });
      if (command === "p4_opened") return Promise.resolve([
        { path: "/project/first.ts", depot: "//depot/first.ts", action: "edit", change: "default" },
        { path: "/project/second.ts", depot: "//depot/second.ts", action: "edit", change: "default" },
        { path: "/project/numbered.ts", depot: "//depot/numbered.ts", action: "edit", change: "123" },
      ]);
      if (command === "p4_diff" && args?.path.endsWith("first.ts")) return Promise.resolve("old diff contents");
      if (command === "p4_diff") return Promise.reject({ message: "Diff unavailable" });
      return Promise.resolve("");
    });
    render(<PerforceToolWindow />);
    fireEvent.click(await screen.findByRole("button", { name: /first\.ts/ }));
    expect(await screen.findByText("old diff contents")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /first\.ts/ }));
    expect(screen.getByText("old diff contents")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /second\.ts/ }));
    expect(screen.queryByText("old diff contents")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("Diff unavailable");
    expect(screen.queryByText("old diff contents")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Include /project/numbered.ts in submit" })).toBeDisabled();
  });
});
