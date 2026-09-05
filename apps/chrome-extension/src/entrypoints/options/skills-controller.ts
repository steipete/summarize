import {
  deleteSkill,
  getSkill,
  listSkills,
  type Skill,
  saveSkill,
} from "../../automation/skills-store";
import { getActiveExtensionLocale, translateExtensionText } from "../../lib/i18n";

type SkillConflict = { skill: Skill; selected: boolean };

export function createSkillsController({
  elements,
  setStatus,
  flashStatus,
}: {
  elements: {
    searchEl: HTMLInputElement;
    listEl: HTMLDivElement;
    emptyEl: HTMLDivElement;
    conflictsEl: HTMLDivElement;
    exportBtn: HTMLButtonElement;
    importBtn: HTMLButtonElement;
  };
  setStatus: (text: string) => void;
  flashStatus: (text: string, duration?: number) => void;
}) {
  let skillsCache: Skill[] = [];
  let skillsFiltered: Skill[] = [];
  let skillsSearchQuery = "";
  let editingSkill: Skill | null = null;
  let importConflicts: SkillConflict[] = [];
  let importedSkills: Skill[] = [];

  const updateSkillsEmptyState = () => {
    elements.emptyEl.textContent = skillsSearchQuery
      ? "No skills match your search."
      : "No skills created yet.";
    elements.emptyEl.hidden = skillsFiltered.length > 0 || importConflicts.length > 0;
  };

  const updateSkillDraft = (patch: Partial<Skill>) => {
    if (!editingSkill) return;
    editingSkill = { ...editingSkill, ...patch };
  };

  const loadSkills = async () => {
    skillsCache = (await listSkills()).sort((a, b) => a.name.localeCompare(b.name));
    filterSkills();
  };

  const deleteSkillWithPrompt = async (skill: Skill) => {
    if (
      !confirm(translateExtensionText(`Delete skill "${skill.name}"?`, getActiveExtensionLocale()))
    )
      return;
    await deleteSkill(skill.name);
    editingSkill = null;
    await loadSkills();
  };

  const saveEditingSkill = async () => {
    if (!editingSkill) return;
    const now = new Date().toISOString();
    const toSave: Skill = {
      ...editingSkill,
      createdAt: editingSkill.createdAt || now,
      lastUpdated: now,
    };
    await saveSkill(toSave);
    editingSkill = null;
    await loadSkills();
  };

  const performImport = async (skills: Skill[]) => {
    const skip = new Set(importConflicts.filter((c) => !c.selected).map((c) => c.skill.name));
    const toImport = skills.filter((skill) => !skip.has(skill.name));
    for (const skill of toImport) {
      await saveSkill(skill);
    }
    importConflicts = [];
    importedSkills = [];
    await loadSkills();
    flashStatus(`Imported ${toImport.length} skill(s).`);
  };

  const renderSkills = () => {
    elements.listEl.replaceChildren();
    elements.conflictsEl.replaceChildren();

    if (importConflicts.length > 0) {
      elements.conflictsEl.hidden = false;
      const title = document.createElement("div");
      title.className = "skillName";
      title.textContent = "Import conflicts";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Select which skills should overwrite existing entries.";
      const list = document.createElement("div");
      list.className = "skillsConflictsList";

      importConflicts.forEach((conflict, index) => {
        const row = document.createElement("label");
        row.className = "skillsConflictItem";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = conflict.selected;
        checkbox.addEventListener("change", () => {
          importConflicts[index] = { ...conflict, selected: checkbox.checked };
        });

        const content = document.createElement("div");
        content.style.display = "grid";
        content.style.gap = "2px";

        const name = document.createElement("div");
        name.className = "skillName";
        name.dataset.localeIgnore = "true";
        name.textContent = conflict.skill.name;

        const domains = document.createElement("div");
        domains.className = "skillDomains";
        domains.dataset.localeIgnore = "true";
        domains.textContent = conflict.skill.domainPatterns.join(", ");

        const desc = document.createElement("div");
        desc.className = "skillDescription";
        desc.dataset.localeIgnore = "true";
        desc.textContent = conflict.skill.shortDescription;

        content.append(name, domains, desc);
        row.append(checkbox, content);
        list.append(row);
      });

      const actions = document.createElement("div");
      actions.className = "skillsConflictActions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "miniButton";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => {
        importConflicts = [];
        importedSkills = [];
        renderSkills();
      });
      const importBtn = document.createElement("button");
      importBtn.type = "button";
      importBtn.className = "miniButton";
      importBtn.textContent = "Import selected";
      importBtn.addEventListener("click", () => {
        void performImport(importedSkills);
      });
      actions.append(cancelBtn, importBtn);

      elements.conflictsEl.append(title, hint, list, actions);
      updateSkillsEmptyState();
      return;
    }

    elements.conflictsEl.hidden = true;

    for (const skill of skillsFiltered) {
      if (editingSkill && editingSkill.name === skill.name) {
        const editor = document.createElement("div");
        editor.className = "skillEditor";

        const heading = document.createElement("div");
        heading.className = "skillName";
        heading.dataset.localeIgnore = "true";
        heading.textContent = `Edit skill: ${editingSkill.name}`;

        const nameLabel = document.createElement("label");
        const nameLabelText = document.createElement("span");
        nameLabelText.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = editingSkill.name;
        nameInput.disabled = true;
        nameLabel.append(nameLabelText, nameInput);

        const domainLabel = document.createElement("label");
        const domainLabelText = document.createElement("span");
        domainLabelText.textContent = "Domain patterns (comma-separated)";
        const domainInput = document.createElement("input");
        domainInput.type = "text";
        domainInput.value = editingSkill.domainPatterns.join(", ");
        domainInput.addEventListener("input", () => {
          const patterns = domainInput.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          updateSkillDraft({ domainPatterns: patterns });
        });
        domainLabel.append(domainLabelText, domainInput);

        const shortLabel = document.createElement("label");
        const shortText = document.createElement("span");
        shortText.textContent = "Short description";
        const shortInput = document.createElement("input");
        shortInput.type = "text";
        shortInput.value = editingSkill.shortDescription;
        shortInput.addEventListener("input", () =>
          updateSkillDraft({ shortDescription: shortInput.value }),
        );
        shortLabel.append(shortText, shortInput);

        const descriptionLabel = document.createElement("label");
        const descriptionText = document.createElement("span");
        descriptionText.textContent = "Description (Markdown)";
        const descriptionInput = document.createElement("textarea");
        descriptionInput.rows = 4;
        descriptionInput.value = editingSkill.description;
        descriptionInput.addEventListener("input", () =>
          updateSkillDraft({ description: descriptionInput.value }),
        );
        descriptionLabel.append(descriptionText, descriptionInput);

        const examplesLabel = document.createElement("label");
        const examplesText = document.createElement("span");
        examplesText.textContent = "Examples (JavaScript)";
        const examplesInput = document.createElement("textarea");
        examplesInput.rows = 4;
        examplesInput.value = editingSkill.examples;
        examplesInput.addEventListener("input", () =>
          updateSkillDraft({ examples: examplesInput.value }),
        );
        examplesLabel.append(examplesText, examplesInput);

        const libraryLabel = document.createElement("label");
        const libraryText = document.createElement("span");
        libraryText.textContent = "Library code";
        const libraryInput = document.createElement("textarea");
        libraryInput.rows = 8;
        libraryInput.value = editingSkill.library;
        libraryInput.addEventListener("input", () =>
          updateSkillDraft({ library: libraryInput.value }),
        );
        libraryLabel.append(libraryText, libraryInput);

        const actionRow = document.createElement("div");
        actionRow.className = "skillActions";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "miniButton";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => {
          editingSkill = null;
          renderSkills();
        });
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "miniButton";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", () => {
          void saveEditingSkill();
        });
        actionRow.append(cancelBtn, saveBtn);

        editor.append(
          heading,
          nameLabel,
          domainLabel,
          shortLabel,
          descriptionLabel,
          examplesLabel,
          libraryLabel,
          actionRow,
        );
        elements.listEl.append(editor);
        continue;
      }

      const card = document.createElement("div");
      card.className = "skillCard";

      const header = document.createElement("div");
      header.className = "skillHeader";

      const name = document.createElement("div");
      name.className = "skillName";
      name.dataset.localeIgnore = "true";
      name.textContent = skill.name;

      const domains = document.createElement("div");
      domains.className = "skillDomains";
      domains.dataset.localeIgnore = "true";
      domains.textContent = skill.domainPatterns.join(", ");

      header.append(name, domains);

      const desc = document.createElement("div");
      desc.className = "skillDescription";
      desc.dataset.localeIgnore = "true";
      desc.textContent = skill.shortDescription;

      const actions = document.createElement("div");
      actions.className = "skillActions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "miniButton";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => {
        editingSkill = { ...skill };
        renderSkills();
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "miniButton";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        void deleteSkillWithPrompt(skill);
      });
      actions.append(editBtn, deleteBtn);

      card.append(header, desc, actions);
      elements.listEl.append(card);
    }

    updateSkillsEmptyState();
  };

  const filterSkills = () => {
    const query = skillsSearchQuery.toLowerCase();
    skillsFiltered = skillsCache.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.shortDescription.toLowerCase().includes(query) ||
        skill.domainPatterns.some((pattern) => pattern.toLowerCase().includes(query)),
    );
    renderSkills();
  };

  const coerceSkill = (raw: unknown): Skill | null => {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) return null;
    const domainPatterns = Array.isArray(obj.domainPatterns)
      ? obj.domainPatterns.map((pattern) => String(pattern).trim()).filter(Boolean)
      : [];
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString();
    const lastUpdated = typeof obj.lastUpdated === "string" ? obj.lastUpdated : createdAt;
    return {
      name,
      domainPatterns,
      shortDescription: typeof obj.shortDescription === "string" ? obj.shortDescription : "",
      description: typeof obj.description === "string" ? obj.description : "",
      examples: typeof obj.examples === "string" ? obj.examples : "",
      library: typeof obj.library === "string" ? obj.library : "",
      createdAt,
      lastUpdated,
    };
  };

  const exportSkills = async () => {
    const all = await listSkills();
    const json = JSON.stringify(all, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `summarize-skills-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSkills = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) {
            setStatus("Invalid skills file: expected an array.");
            return;
          }
          const incoming = parsed
            .map(coerceSkill)
            .filter((skill): skill is Skill => Boolean(skill));
          importedSkills = incoming;

          const conflicts: SkillConflict[] = [];
          for (const skill of incoming) {
            const existing = await getSkill(skill.name);
            if (existing) conflicts.push({ skill, selected: true });
          }

          if (conflicts.length > 0) {
            importConflicts = conflicts;
            renderSkills();
            return;
          }

          await performImport(incoming);
        } catch (error) {
          setStatus(
            `Failed to import skills: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    });
    input.click();
  };

  return {
    bind() {
      elements.searchEl.addEventListener("input", () => {
        skillsSearchQuery = elements.searchEl.value.trim();
        filterSkills();
      });
      elements.exportBtn.addEventListener("click", () => {
        void exportSkills();
      });
      elements.importBtn.addEventListener("click", () => {
        void importSkills();
      });
    },
    load: loadSkills,
  };
}
