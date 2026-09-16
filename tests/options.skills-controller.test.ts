import { beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment happy-dom
import { message } from "../apps/chrome-extension/src/lib/i18n";

vi.mock("../apps/chrome-extension/src/automation/skills-store.js", () => ({
  deleteSkill: vi.fn(async () => true),
  getSkill: vi.fn(async () => null),
  listSkills: vi.fn(async () => []),
  saveSkill: vi.fn(async (skill: unknown) => skill),
}));

import {
  deleteSkill,
  getSkill,
  listSkills,
  saveSkill,
  type Skill,
} from "../apps/chrome-extension/src/automation/skills-store.js";
import { createSkillsController } from "../apps/chrome-extension/src/entrypoints/options/skills-controller.js";

function createSkill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    domainPatterns: ["example.com/*"],
    shortDescription: `${name} summary`,
    description: `${name} description`,
    examples: "",
    library: "",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastUpdated: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function createElements() {
  return {
    searchEl: document.createElement("input"),
    listEl: document.createElement("div"),
    emptyEl: document.createElement("div"),
    conflictsEl: document.createElement("div"),
    exportBtn: document.createElement("button"),
    importBtn: document.createElement("button"),
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installImportFile(file: File) {
  const originalCreateElement = document.createElement.bind(document);
  const input = originalCreateElement("input") as HTMLInputElement;
  let used = false;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  input.click = () => {
    input.dispatchEvent(new Event("change"));
  };
  return vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (!used && tagName.toLowerCase() === "input") {
      used = true;
      return input;
    }
    return originalCreateElement(tagName);
  }) as typeof document.createElement);
}

describe("options skills controller", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  it("loads, filters, edits, and deletes skills", async () => {
    vi.mocked(listSkills).mockResolvedValue([createSkill("alpha"), createSkill("beta")]);
    const setStatus = vi.fn();
    const flashStatus = vi.fn();
    const elements = createElements();
    const controller = createSkillsController({ elements, setStatus, flashStatus });

    controller.bind();
    await controller.load();

    expect(elements.listEl.textContent).toContain("alpha");
    expect(elements.listEl.textContent).toContain("beta");

    elements.searchEl.value = "zzz";
    elements.searchEl.dispatchEvent(new Event("input"));
    expect(elements.emptyEl.hidden).toBe(false);
    expect(elements.emptyEl.textContent).toBe("No skills match your search.");

    elements.searchEl.value = "";
    elements.searchEl.dispatchEvent(new Event("input"));
    const editButton = Array.from(elements.listEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    editButton?.click();
    const shortInput = Array.from(elements.listEl.querySelectorAll("input")).find(
      (input) => input.value === "alpha summary",
    ) as HTMLInputElement | undefined;
    shortInput!.value = "updated alpha summary";
    shortInput!.dispatchEvent(new Event("input"));
    const saveButton = Array.from(elements.listEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    saveButton?.click();
    await flush();

    expect(saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", shortDescription: "updated alpha summary" }),
    );

    await controller.load();
    const deleteButton = Array.from(elements.listEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    deleteButton?.click();
    await flush();

    expect(deleteSkill).toHaveBeenCalledWith("alpha");
    expect(setStatus).not.toHaveBeenCalled();
    expect(flashStatus).not.toHaveBeenCalled();
  });

  it("exports the current skills as json", async () => {
    vi.mocked(listSkills).mockResolvedValue([createSkill("alpha")]);
    const elements = createElements();
    const controller = createSkillsController({
      elements,
      setStatus: vi.fn(),
      flashStatus: vi.fn(),
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    controller.bind();
    await controller.load();
    elements.exportBtn.click();
    await flush();

    expect(createObjectURL).toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("shows an error for invalid import payloads", async () => {
    const setStatus = vi.fn();
    const elements = createElements();
    const controller = createSkillsController({
      elements,
      setStatus,
      flashStatus: vi.fn(),
    });
    controller.bind();
    await controller.load();

    const restore = installImportFile(
      new File(['{"name":"alpha"}'], "skills.json", { type: "application/json" }),
    );
    elements.importBtn.click();
    await flush();
    restore.mockRestore();

    expect(setStatus).toHaveBeenCalledWith(message("invalid.skills.file.expected.an.array"));
  });

  it("renders import conflicts and can cancel or import selected skills", async () => {
    vi.mocked(listSkills).mockResolvedValue([createSkill("alpha")]);
    vi.mocked(getSkill).mockImplementation(async (name) =>
      name === "alpha" ? createSkill("alpha", { shortDescription: "existing" }) : null,
    );
    const flashStatus = vi.fn();
    const elements = createElements();
    const controller = createSkillsController({
      elements,
      setStatus: vi.fn(),
      flashStatus,
    });
    controller.bind();
    await controller.load();

    let restore = installImportFile(
      new File([JSON.stringify([createSkill("alpha"), createSkill("beta")])], "skills.json", {
        type: "application/json",
      }),
    );
    elements.importBtn.click();
    await flush();
    restore.mockRestore();

    expect(elements.conflictsEl.hidden).toBe(false);
    expect(elements.conflictsEl.textContent).toContain("Import conflicts");

    const cancelButton = Array.from(elements.conflictsEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    );
    cancelButton?.click();
    expect(elements.conflictsEl.hidden).toBe(true);

    restore = installImportFile(
      new File([JSON.stringify([createSkill("alpha"), createSkill("beta")])], "skills.json", {
        type: "application/json",
      }),
    );
    elements.importBtn.click();
    await flush();
    restore.mockRestore();

    const checkbox = elements.conflictsEl.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    const importButton = Array.from(elements.conflictsEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Import selected",
    );
    importButton?.click();
    await flush();

    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "beta" }));
    expect(saveSkill).not.toHaveBeenCalledWith(expect.objectContaining({ name: "alpha" }));
    expect(flashStatus).toHaveBeenCalledWith(message("skills.imported", { count: 1 }));
  });
});
