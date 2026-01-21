const vscode = acquireVsCodeApi();
const itemMap = new Map();

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "setChildren":
            renderChildren(message.element, message.children);
            break;
        case "newItem":
            startAdd();
            break;
        case "updateItems":
            updateItems(message.items);
            break;
        case "refresh":
            requestChildren();
            break;
    }
});

function requestChildren(element) {
    vscode.postMessage({ type: "getChildren", element });
}

function getItemHtml(item) {
    let actionsHtml = "";
    let editValue = `<span class="codicon codicon-edit-sparkle" onclick="startEdit(this, '${item.id}', 'value')" title="Edit Value"></span>`;
    if (item.hasChildren) {
        editValue = "";
    }
    let hexFormat = `<span class="codicon codicon-variable-group" onclick="selectFormat(event, '${item.id}')" title="Select Format"></span>`;

    if (item.id !== "dummy-msg") {
        if (!item.hasChildren) {
            // Leaf node, maybe inside children or top level
            actionsHtml = `
                <div class="actions">
                    ${editValue}
                    ${hexFormat}
                </div>
            `;
        }

        // Improve Check: We need to know if it's top level to show full actions.
        // In renderChildren we know 'parent'. In updateItems we might not know context easily,
        // but typically 'updateItems' is for values.
        // Let's rely on checking if it has a parent in the DOM or itemMap if we want perfect fidelity,
        // but for now let's reuse the logic from renderChildren slightly more generally.

        // Actually, the original logic had specialized actions for "Top-level and not dummy".
        // "Top-level" meant !parent in renderChildren.
        // In updateItems, we just update content. We can assume the structure (actions) doesn't change wildly
        // OR we can try to preserve the actions logic.

        // Simplification: The actions HTML generation logic relies on 'parent'.
        // If we want to extract this, we need 'parent' info.
        // ItemMap items don't store parent ref currently.
        // Let's update itemMap to store parentId?
    }

    // START RE-INLINE
    // To cleanly refactor without breaking the parent check logic, I will pass 'isTopLevel' to the helper.
    return "";
}

function generateItemContentHtml(item, isTopLevel) {
    if (item.id === "dummy-msg") {
        return `<span class="dummy-msg">${item.label}</span>`;
    }
    let actionsHtml = "";
    let editValueButton = `<span class="codicon codicon-edit-sparkle" onclick="editValue(event, '${item.id}')" title="Edit Value"></span>\n`;
    let editValueText = `<span class="value ${item.changed ? "changed" : ""}" ondblclick="startEdit(this, '${item.id}', 'value')">${item.value || ""}</span>\n`;
    let editLabelText = `<span class="label" ondblclick="startEdit(this, '${item.id}', 'label')">${item.label}</span>\n`;
    if (item.hasChildren || item.readonly) {
        editValueButton = "";
        if (item.readonly) {
            editValueText = `<span class="value readonly ${item.changed ? "changed" : ""}">${item.value || ""}</span>\n`;
        } else {
            editValueText = `<span class="value ${item.changed ? "changed" : ""}">${item.value || ""}</span>\n`;
        }
    }
    let hexFormat = `<span class="codicon codicon-variable-group" onclick="selectFormat(event, '${item.id}')" title="Select Format"></span>\n`;

    if (isTopLevel) {
        actionsHtml = `
            <div class="actions">
                <span class="codicon codicon-edit" onclick="editLabel(event, '${item.id}')" title="Edit Expression"></span>
                ${editValueButton}
                ${hexFormat}
                <span class="codicon codicon-arrow-up" onclick="moveUp(event, '${item.id}')" title="Move Up"></span>
                <span class="codicon codicon-arrow-down" onclick="moveDown(event, '${item.id}')" title="Move Down"></span>
                <span class="codicon codicon-close" onclick="deleteItem(event, '${item.id}')" title="Delete"></span>
            </div>
        `;
    } else if (!item.hasChildren) {
        editLabelText = `<span class="label">${item.label}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }
    if (!isTopLevel) {
        editLabelText = `<span class="label">${item.label}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }

    const chevronClass = item.expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const labelEscaped = (item.contextValue || "").replace(/"/g, "&quot;");
    const valueEscaped = (item.value || "").replace(/"/g, "&quot;");
    const editLabelWithTitle = editLabelText.replace(/(<span class="label"[^>]*>)/, `$1<span title="${labelEscaped}">`);
    const editValueWithTitle = editValueText.replace(/(<span class="value[^"]*"[^>]*>)/, `$1<span title="${valueEscaped}">`);
    return `
        <span class="codicon ${chevronClass} ${item.hasChildren ? "" : "hidden"}" onclick="toggleExpand(event, '${item.id}')"></span>
        ${editLabelWithTitle}</span>
        ${editValueWithTitle}</span>
        ${actionsHtml}
    `;
}

function updateItems(items) {
    items.forEach((newItem) => {
        const existingItem = itemMap.get(newItem.id);
        if (existingItem) {
            // Update local state
            Object.assign(existingItem, newItem);

            const li = document.querySelector(`li[data-id="${newItem.id}"]`);
            if (li) {
                const contentDiv = li.querySelector(".tree-content");
                if (contentDiv) {
                    // Determine if top level.
                    // renderChildren logic: !parent.
                    // Here we check if li.parentElement is #tree-root > ul
                    const isTopLevel = li.parentElement && li.parentElement.parentElement && li.parentElement.parentElement.id === "tree-root";
                    const newHtml = generateItemContentHtml(existingItem, isTopLevel);
                    if (contentDiv.innerHTML !== newHtml) {
                        contentDiv.innerHTML = newHtml;
                    }
                }
            }
        }
    });
}

function renderChildren(parent, children) {
    const container = parent ? document.getElementById("children-" + parent.id) : document.getElementById("tree-root");
    if (!container) return;

    // container.innerHTML = ""; // Removing full wipe to prevent shimmering
    let ul = container.querySelector("ul");
    if (!ul) {
        ul = document.createElement("ul");
        container.appendChild(ul);
    }

    const existingLiMap = new Map();
    Array.from(ul.children).forEach((li) => {
        if (li.dataset.id) existingLiMap.set(li.dataset.id, li);
    });

    const keepIds = new Set();

    children.forEach((item) => {
        itemMap.set(item.id, item);
        keepIds.add(item.id);

        let li = existingLiMap.get(item.id);
        let contentDiv;

        if (!li) {
            li = document.createElement("li");
            li.className = "tree-item";
            li.dataset.id = item.id;

            contentDiv = document.createElement("div");
            contentDiv.className = "tree-content";
            li.appendChild(contentDiv);
        } else {
            contentDiv = li.querySelector(".tree-content");
        }

        const isTopLevel = !parent;
        const newHtml = generateItemContentHtml(item, isTopLevel);

        // Only update DOM if content changed
        if (contentDiv.innerHTML !== newHtml) {
            contentDiv.innerHTML = newHtml;
        }

        let childContainer = document.getElementById("children-" + item.id);
        if (item.hasChildren) {
            if (!childContainer) {
                childContainer = document.createElement("div");
                childContainer.id = "children-" + item.id;
                li.appendChild(childContainer);

                if (item.expanded) {
                    requestChildren(item);
                }
            } else {
                // If it exists and is expanded, we continue the refresh cascade
                if (item.expanded) {
                    requestChildren(item);
                }
            }
        } else {
            if (childContainer) childContainer.remove();
        }

        // Ensure order
        ul.appendChild(li);
    });

    // Remove deleted nodes
    existingLiMap.forEach((li, id) => {
        if (!keepIds.has(id)) li.remove();
    });
}

// Primitive Edit Logic - using floating overlay to survive rapid DOM updates
window.startEdit = (element, id, field) => {
    // Remove any existing floating editor
    const existingEditor = document.querySelector(".floating-editor");
    const existingBackdrop = document.querySelector(".floating-editor-backdrop");
    if (existingEditor) existingEditor.remove();
    if (existingBackdrop) existingBackdrop.remove();

    let currentVal = element.innerText;
    if (field === "value") {
        const item = itemMap.get(id);
        if (item && item.actualValue !== undefined) {
            currentVal = item.actualValue;
        }
    }

    // Create backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "floating-editor-backdrop";
    document.body.appendChild(backdrop);

    // Create floating editor
    const editor = document.createElement("div");
    editor.className = "floating-editor";

    // Add title
    const title = document.createElement("div");
    title.className = "floating-editor-title";
    title.textContent = field === "label" ? "Edit Expression" : "Edit Value";
    editor.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentVal;

    editor.appendChild(input);
    document.body.appendChild(editor);

    // Position at top center like startAdd
    editor.style.left = "50%";
    editor.style.top = "20px";
    editor.style.transform = "translateX(-50%)";
    editor.style.minWidth = "300px";

    let cancelled = false;

    const cleanup = () => {
        editor.remove();
        backdrop.remove();
    };

    const commit = () => {
        if (!cancelled && input.value !== currentVal) {
            vscode.postMessage({ type: "edit", item: { id }, field: field, value: input.value });
        }
        cleanup();
    };

    input.onblur = () => {
        // Blur means focus lost - treat as cancel
        cancelled = true;
        cleanup();
    };

    input.onkeydown = (e) => {
        if (e.key === "Enter") {
            commit();
        } else if (e.key === "Escape") {
            cancelled = true;
            cleanup();
        }
    };

    backdrop.onclick = () => {
        cancelled = true;
        cleanup();
    };

    input.focus();
    input.select();
};

// create a dropdown for format selection
window.selectFormat = (event, id) => {
    event.stopPropagation();

    // Remove existing menus if any
    const existing = document.querySelector(".context-menu");
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.className = "context-menu";

    const formats = [
        { label: "Natural", value: "natural" },
        { label: "Decimal", value: "decimal" },
        { label: "Hex", value: "hex" },
        { label: "Octal", value: "octal" },
        { label: "Binary", value: "binary" },
    ];

    formats.forEach((fmt) => {
        const item = document.createElement("div");
        item.className = "context-menu-item";
        item.innerText = fmt.label;
        item.onclick = () => {
            vscode.postMessage({ type: "setFormat", item: { id }, format: fmt.value });
            menu.remove();
        };
        menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Positioning logic
    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;

    // Boundary check
    if (x + rect.width > window.innerWidth) {
        x = window.innerWidth - rect.width;
    }
    if (y + rect.height > window.innerHeight) {
        y = window.innerHeight - rect.height;
    }

    menu.style.left = x + "px";
    menu.style.top = y + "px";

    // Click outside to close
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener("click", closeMenu);
            document.removeEventListener("contextmenu", closeMenu);
        }
    };

    // Use setTimeout to avoid immediate trigger by the current click event
    setTimeout(() => {
        document.addEventListener("click", closeMenu);
        document.addEventListener("contextmenu", closeMenu);
    }, 0);
};

function startAdd() {
    // Remove any existing floating editor
    const existingEditor = document.querySelector(".floating-editor");
    const existingBackdrop = document.querySelector(".floating-editor-backdrop");
    if (existingEditor) existingEditor.remove();
    if (existingBackdrop) existingBackdrop.remove();

    // Create backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "floating-editor-backdrop";
    document.body.appendChild(backdrop);

    // Create floating editor
    const editor = document.createElement("div");
    editor.className = "floating-editor";
    // Add title
    const title = document.createElement("div");
    title.className = "floating-editor-title";
    title.textContent = "Add New Expression";
    editor.appendChild(title);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Expression";

    editor.appendChild(input);
    document.body.appendChild(editor);

    // Position at top center of viewport
    editor.style.left = "50%";
    editor.style.top = "20px";
    editor.style.transform = "translateX(-50%)";
    editor.style.minWidth = "300px";

    let cancelled = false;

    const cleanup = () => {
        editor.remove();
        backdrop.remove();
    };

    const commit = () => {
        if (!cancelled && input.value) {
            vscode.postMessage({ type: "add", value: input.value });
        }
        cleanup();
    };

    input.onblur = () => {
        // Blur means focus lost - treat as cancel
        cancelled = true;
        cleanup();
    };

    input.onkeydown = (e) => {
        if (e.key === "Enter") {
            commit();
        } else if (e.key === "Escape") {
            cancelled = true;
            cleanup();
        }
    };

    backdrop.onclick = () => {
        cancelled = true;
        cleanup();
    };

    input.focus();
}

// Helper functions for action buttons to find and edit the correct element
window.editLabel = (event, id) => {
    event.stopPropagation();
    const treeContent = event.target.closest(".tree-content");
    const labelSpan = treeContent.querySelector(".label");
    if (labelSpan) {
        startEdit(labelSpan, id, "label");
    }
};

window.editValue = (event, id) => {
    event.stopPropagation();
    const treeContent = event.target.closest(".tree-content");
    const valueSpan = treeContent.querySelector(".value");
    if (valueSpan) {
        startEdit(valueSpan, id, "value");
    }
};

window.toggleExpand = (e, id) => {
    e.stopPropagation();
    const item = itemMap.get(id);
    const chevron = e.target;
    if (item.expanded) {
        item.expanded = false;
        chevron.classList.remove("codicon-chevron-down");
        chevron.classList.add("codicon-chevron-right");
        const container = document.getElementById("children-" + id);
        if (container) container.innerHTML = "";
        vscode.postMessage({ type: "setExpanded", item: { id }, expanded: false });
    } else {
        item.expanded = true;
        chevron.classList.remove("codicon-chevron-right");
        chevron.classList.add("codicon-chevron-down");
        vscode.postMessage({ type: "setExpanded", item: { id }, expanded: true });
        requestChildren(item);
    }
};

window.moveUp = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "moveUp", item: { id } });
};

window.moveDown = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "moveDown", item: { id } });
};

window.deleteItem = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "delete", item: { id } });
};

// Initial load
requestChildren();
