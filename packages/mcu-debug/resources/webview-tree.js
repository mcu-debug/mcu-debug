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
        case "refresh":
            requestChildren();
            break;
    }
});

function requestChildren(element) {
    vscode.postMessage({ type: "getChildren", element });
}

function renderChildren(parent, children) {
    const container = parent ? document.getElementById("children-" + parent.id) : document.getElementById("tree-root");
    if (!container) return;

    container.innerHTML = "";
    const ul = document.createElement("ul");
    children.forEach((item) => {
        itemMap.set(item.id, item);
        const li = document.createElement("li");
        li.className = "tree-item";

        const content = document.createElement("div");
        content.className = "tree-content";

        let actionsHtml = "";
        let editValue = `<span class="codicon codicon-edit-sparkle" onclick="startEdit(this, '${item.id}', 'value')" title="Edit Value"></span>`;
        if (item.hasChildren) {
            editValue = "";
        }
        let hexFormat = `<span class="codicon codicon-variable-group" onclick="selectFormat(event, '${item.id}')" title="Select Format"></span>`;

        if (!parent && item.id !== "dummy-msg") {
            // Top-level and not dummy
            actionsHtml = `
                <div class="actions">
                    <span class="codicon codicon-edit" onclick="startEdit(this, '${item.id}', 'label')" title="Edit Expression"></span>
                    ${editValue}
                    ${hexFormat}
                    <span class="codicon codicon-arrow-up" onclick="moveUp(event, '${item.id}')" title="Move Up"></span>
                    <span class="codicon codicon-arrow-down" onclick="moveDown(event, '${item.id}')" title="Move Down"></span>
                    <span class="codicon codicon-close" onclick="deleteItem(event, '${item.id}')" title="Delete"></span>
                </div>
            `;
        } else if (item.id !== "dummy-msg" && !item.hasChildren) {
            actionsHtml = `
                <div class="actions">
                    ${editValue}
                    ${hexFormat}
                </div>
            `;
        }

        content.innerHTML = `
            <span class="codicon codicon-chevron-right ${item.hasChildren ? "" : "hidden"}"></span>
            <span class="label" ondblclick="startEdit(this, '${item.id}', 'label')">${item.label}</span>
            <span class="value ${item.changed ? "changed" : ""}" ondblclick="startEdit(this, '${item.id}', 'value')">${item.value || ""}</span>
            ${actionsHtml}
        `;

        li.appendChild(content);
        if (item.hasChildren) {
            const childContainer = document.createElement("div");
            childContainer.id = "children-" + item.id;
            li.appendChild(childContainer);
        }
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

// Primitive Edit Logic
window.startEdit = (element, id, field) => {
    let currentVal = element.innerText;
    if (field === "value") {
        const item = itemMap.get(id);
        if (item && item.actualValue !== undefined) {
            currentVal = item.actualValue;
        }
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentVal;
    input.onblur = () => {
        if (input.value !== currentVal) {
            vscode.postMessage({ type: "edit", item: { id }, value: input.value });
        }
        element.innerText = input.value; // Optimistic update
    };
    input.onkeydown = (e) => {
        if (e.key === "Enter") input.blur();
    };
    element.innerHTML = "";
    element.appendChild(input);
    input.focus();
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
    const container = document.getElementById("tree-root");
    let ul = container.querySelector("ul");
    if (!ul) {
        ul = document.createElement("ul");
        container.appendChild(ul);
    }

    const li = document.createElement("li");
    li.className = "tree-item";
    const content = document.createElement("div");
    content.className = "tree-content";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Expression";

    content.appendChild(input);
    li.appendChild(content);
    ul.appendChild(li);

    input.focus();

    const commit = () => {
        if (input.value) {
            vscode.postMessage({ type: "add", value: input.value });
        }
        // The refresh will kill this node anyway
    };

    input.onblur = commit;
    input.onkeydown = (e) => {
        if (e.key === "Enter") {
            input.blur();
        } else if (e.key === "Escape") {
            li.remove();
        }
    };
}

// Initial load
requestChildren();

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
