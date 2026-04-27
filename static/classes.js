(function () {
  const visibleCount = document.querySelector("#visible-class-count");
  const showAllButton = document.querySelector("#show-all-classes");
  const sectionButtons = Array.from(document.querySelectorAll("[data-section-toggle]"));
  const trees = [];
  const collapsedSections = new Map();

  function initTree(kind) {
    const rows = Array.from(document.querySelectorAll(`[data-tree-row="${kind}"]`));
    const panels = Array.from(document.querySelectorAll(`[data-tree-panel="${kind}"]`));
    const buttons = Array.from(document.querySelectorAll(`[data-tree-toggle="${kind}"]`));

    if (!rows.length || !panels.length) {
      return null;
    }

    const parents = new Map();
    const children = new Map();
    const rowByName = new Map();
    const panelsByName = new Map();
    const collapsedByName = new Map();

    rows.forEach((row) => {
      const name = row.dataset.treeName;
      if (!name) {
        return;
      }
      rowByName.set(name, row);
      parents.set(name, row.dataset.treeParent || "");
    });

    panels.forEach((panel) => {
      const name = panel.dataset.treeName;
      if (name) {
        const namedPanels = panelsByName.get(name) || [];
        namedPanels.push(panel);
        panelsByName.set(name, namedPanels);
      }
    });

    parents.forEach((parentName, name) => {
      if (!parentName) {
        return;
      }
      const siblings = children.get(parentName) || [];
      siblings.push(name);
      children.set(parentName, siblings);
    });

    buttons.forEach((button) => {
      const name = button.dataset.treeName;
      if (name) {
        collapsedByName.set(name, false);
      }
    });

    function ancestorsExpanded(name) {
      let parent = parents.get(name);
      const seen = new Set();

      while (parent && !seen.has(parent)) {
        seen.add(parent);
        if (collapsedByName.get(parent)) {
          return false;
        }
        parent = parents.get(parent);
      }

      return true;
    }

    function apply() {
      let visiblePanels = 0;

      rowByName.forEach((row, name) => {
        const hidden = !ancestorsExpanded(name);
        row.hidden = hidden;
        row.classList.toggle("is-tree-hidden", hidden);
      });

      panelsByName.forEach((namedPanels, name) => {
        const visible = ancestorsExpanded(name);
        namedPanels.forEach((panel) => {
          panel.hidden = !visible;
          panel.classList.toggle("is-tree-hidden", !visible);
        });
        if (visible) {
          visiblePanels += 1;
        }
      });

      buttons.forEach((button) => {
        const name = button.dataset.treeName;
        const collapsed = Boolean(collapsedByName.get(name));
        button.textContent = collapsed ? "+" : "-";
        button.setAttribute("aria-expanded", String(!collapsed));
        button.setAttribute("aria-label", `${collapsed ? "Развернуть" : "Свернуть"} ветку ${name}`);
        button.classList.toggle("is-collapsed", collapsed);
      });

      return visiblePanels;
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.dataset.treeName;
        if (!name || !children.has(name)) {
          return;
        }
        collapsedByName.set(name, !collapsedByName.get(name));
        refreshTrees();
      });
    });

    return {
      kind,
      apply,
      expandAll() {
        collapsedByName.forEach((_, name) => {
          collapsedByName.set(name, false);
        });
      },
    };
  }

  function refreshTrees() {
    let visibleClasses = 0;

    trees.forEach((tree) => {
      const visiblePanels = tree.apply();
      if (tree.kind === "class") {
        visibleClasses = visiblePanels;
      }
    });

    if (visibleCount) {
      visibleCount.textContent = String(visibleClasses);
    }

    applySections();
  }

  function applySections() {
    sectionButtons.forEach((button) => {
      const section = button.dataset.sectionToggle;
      const collapsed = Boolean(collapsedSections.get(section));
      const rows = Array.from(document.querySelectorAll(`[data-sidebar-section="${section}"]`));

      button.textContent = collapsed ? "+" : "-";
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-label", `${collapsed ? "Развернуть" : "Свернуть"} список ${section}`);
      button.classList.toggle("is-collapsed", collapsed);

      rows.forEach((row) => {
        row.classList.toggle("is-section-hidden", collapsed);
      });
    });
  }

  ["class", "lookup", "domain"].forEach((kind) => {
    const tree = initTree(kind);
    if (tree) {
      trees.push(tree);
    }
  });

  sectionButtons.forEach((button) => {
    const section = button.dataset.sectionToggle;
    if (!section) {
      return;
    }
    collapsedSections.set(section, false);
    button.addEventListener("click", () => {
      collapsedSections.set(section, !collapsedSections.get(section));
      applySections();
    });
  });

  if (showAllButton) {
    showAllButton.addEventListener("click", () => {
      trees.forEach((tree) => {
        tree.expandAll();
      });
      collapsedSections.forEach((_, section) => {
        collapsedSections.set(section, false);
      });
      refreshTrees();
    });
  }

  refreshTrees();
})();
