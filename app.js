import { EVENT_TYPES, createEventFactory, replayEvents } from "./replay.js";
import { createEventStore } from "./storage.js";
import { APP_ID, BOARD_ID, EVENT_SCHEMA } from "./config.js";

const board = document.querySelector("#board");
const activityLine = document.querySelector("#activity-line");
const modeHint = document.querySelector("#mode-hint");
const toolButtons = {
  select: document.querySelector("#tool-select"),
  note: document.querySelector("#tool-note"),
  draw: document.querySelector("#tool-draw")
};
const editButton = document.querySelector("#edit-selected");
const deleteButton = document.querySelector("#delete-selected");
const noteSheet = document.querySelector("#note-sheet");
const noteForm = document.querySelector("#note-form");
const noteText = document.querySelector("#note-text");
const cancelNoteButton = document.querySelector("#cancel-note");
const saveNoteButton = document.querySelector("#save-note");

const BOARD_WIDTH = 1000;
const BOARD_HEIGHT = 680;

const eventStore = createEventStore();
const author = getOrCreateAuthor();
let createEvent = createEventFactory(author);

let currentTool = "select";
let selectedIds = new Set();
let dragState = null;
let drawingState = null;
let selectionState = null;
let noteDraft = null;
let state = replayEvents([]);

init();

async function init() {
  const events = await eventStore.loadEvents();
  createEvent = createEventFactory(author, events.filter((event) => event.author === author).length);
  state = replayEvents(events);
  render();
}

toolButtons.select.addEventListener("click", () => setTool("select"));
toolButtons.note.addEventListener("click", () => {
  setTool("note");
  openNoteSheet({
    mode: "create",
    x: Math.round(BOARD_WIDTH / 2 - 110),
    y: Math.round(BOARD_HEIGHT / 2 - 36),
    text: ""
  });
});
toolButtons.draw.addEventListener("click", () => setTool("draw"));

editButton.addEventListener("click", () => {
  const object = getSingleSelectedObject();

  if (object?.type === "text") {
    openNoteSheet({
      mode: "edit",
      objectId: object.id,
      x: object.x,
      y: object.y,
      text: object.text
    });
  }
});

deleteButton.addEventListener("click", () => {
  const ids = [...selectedIds];

  if (ids.length === 0) {
    return;
  }

  selectedIds.clear();
  ids.forEach((objectId) => appendEvent(EVENT_TYPES.DELETE, { objectId }));
});

cancelNoteButton.addEventListener("click", closeNoteSheet);

noteSheet.addEventListener("click", (event) => {
  if (event.target === noteSheet) {
    closeNoteSheet();
  }
});

noteForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = noteText.value.trim();

  if (!text || !noteDraft) {
    noteText.focus();
    return;
  }

  if (noteDraft.mode === "edit") {
    appendEvent(EVENT_TYPES.EDIT_TEXT, {
      objectId: noteDraft.objectId,
      text
    });
  } else {
    const position = clampNotePosition(noteDraft.x, noteDraft.y);

    appendEvent(EVENT_TYPES.CREATE_TEXT, {
      objectId: `${author}:object:${Date.now()}`,
      x: position.x,
      y: position.y,
      text
    });
  }

  closeNoteSheet();
  setTool("select");
});

board.addEventListener("pointerdown", (event) => {
  const point = getBoardPoint(event);

  if (currentTool === "note") {
    const position = clampNotePosition(point.x, point.y);

    openNoteSheet({
      mode: "create",
      x: position.x,
      y: position.y,
      text: ""
    });
    return;
  }

  if (currentTool === "draw") {
    drawingState = {
      objectId: `${author}:stroke:${Date.now()}`,
      points: [[point.x, point.y]]
    };
    board.setPointerCapture(event.pointerId);
    return;
  }

  const objectId = event.target.closest("[data-object-id]")?.dataset.objectId;
  const object = state.objects.find((candidate) => candidate.id === objectId);

  if (selectedIds.has(objectId) && object?.type === "text") {
    dragState = {
      pointerId: event.pointerId,
      objectId,
      offsetX: point.x - object.x,
      offsetY: point.y - object.y
    };
    board.setPointerCapture(event.pointerId);
    return;
  }

  selectedIds.clear();
  selectionState = {
    pointerId: event.pointerId,
    start: point,
    current: point
  };
  board.setPointerCapture(event.pointerId);
  renderSelectionPreview();
});

board.addEventListener("pointermove", (event) => {
  const point = getBoardPoint(event);

  if (drawingState) {
    drawingState.points.push([point.x, point.y]);
    renderPreviewStroke(drawingState.points);
    return;
  }

  if (selectionState) {
    selectionState.current = point;
    renderSelectionPreview();
    return;
  }

  if (dragState) {
    const object = state.objects.find((candidate) => candidate.id === dragState.objectId);

    if (object) {
      const position = clampNotePosition(point.x - dragState.offsetX, point.y - dragState.offsetY);
      object.x = position.x;
      object.y = position.y;
      render();
    }
  }
});

board.addEventListener("pointerup", (event) => {
  if (drawingState) {
    const points = simplifyPoints(drawingState.points);

    if (points.length > 1) {
      appendEvent(EVENT_TYPES.DRAW_STROKE, {
        objectId: drawingState.objectId,
        points,
        color: "#111111",
        width: 4
      });
    }

    drawingState = null;
    board.releasePointerCapture(event.pointerId);
    return;
  }

  if (selectionState) {
    selectionState.current = getBoardPoint(event);
    selectedIds = new Set(findObjectsInSelection(selectionState).map((object) => object.id));
    selectionState = null;
    board.releasePointerCapture(event.pointerId);
    render();
    return;
  }

  if (dragState) {
    const point = getBoardPoint(event);
    const position = clampNotePosition(point.x - dragState.offsetX, point.y - dragState.offsetY);

    appendEvent(EVENT_TYPES.MOVE, {
      objectId: dragState.objectId,
      x: position.x,
      y: position.y
    });
    board.releasePointerCapture(event.pointerId);
    dragState = null;
  }
});

board.addEventListener("pointercancel", (event) => {
  drawingState = null;
  selectionState = null;
  dragState = null;

  if (board.hasPointerCapture(event.pointerId)) {
    board.releasePointerCapture(event.pointerId);
  }

  render();
});

board.addEventListener("dblclick", (event) => {
  const objectId = event.target.closest("[data-object-id]")?.dataset.objectId;
  const object = state.objects.find((candidate) => candidate.id === objectId);

  if (object?.type !== "text") {
    return;
  }

  openNoteSheet({
    mode: "edit",
    objectId: object.id,
    x: object.x,
    y: object.y,
    text: object.text
  });
});

async function appendEvent(op, payload) {
  const event = createEvent(op, {
    appId: APP_ID,
    boardId: BOARD_ID,
    schema: EVENT_SCHEMA,
    actorName: "Nutzer",
    ...payload
  });
  const events = await eventStore.appendEvent(event);
  state = replayEvents(events);
  render();
}

function setTool(tool) {
  currentTool = tool;

  for (const [name, button] of Object.entries(toolButtons)) {
    button.classList.toggle("is-active", name === tool);
  }

  renderModeHint();
}

function render() {
  board.innerHTML = "";

  for (const object of state.objects) {
    if (object.type === "stroke") {
      renderStroke(object);
    }

    if (object.type === "text") {
      renderTextNote(object);
    }
  }

  renderActivityLine();
  renderModeHint();
  renderSelectionActions();
}

function renderTextNote(object) {
  const group = svgElement("g", {
    "data-object-id": object.id,
    class: `note ${selectedIds.has(object.id) ? "is-selected" : ""}`,
    transform: `translate(${object.x} ${object.y})`
  });
  const lines = wrapText(object.text, 18);
  const height = Math.max(74, lines.length * 20 + 34);

  group.append(
    svgElement("rect", {
      width: 210,
      height,
      rx: 0,
      class: "note-bg"
    })
  );

  lines.forEach((line, index) => {
    const text = svgElement("text", {
      x: 16,
      y: 30 + index * 20,
      class: "note-text"
    });
    text.textContent = line;
    group.append(text);
  });

  board.append(group);
}

function renderStroke(object) {
  const selected = selectedIds.has(object.id);
  const polyline = svgElement("polyline", {
    "data-object-id": object.id,
    class: `stroke ${selected ? "is-selected" : ""}`,
    points: object.points.map(([x, y]) => `${x},${y}`).join(" "),
    fill: "none",
    stroke: object.color,
    "stroke-width": selected ? object.width + 2 : object.width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  });

  board.append(polyline);
}

function renderPreviewStroke(points) {
  render();
  const preview = svgElement("polyline", {
    class: "stroke preview",
    points: points.map(([x, y]) => `${x},${y}`).join(" "),
    fill: "none",
    stroke: "#111111",
    "stroke-width": 4,
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  });

  board.append(preview);
}

function renderActivityLine() {
  const event = state.activity.at(-1);

  if (!event) {
    activityLine.textContent = "Noch keine Aktion";
    return;
  }

  activityLine.textContent = getActionText(event.op);
}

function getBoardPoint(event) {
  const rect = board.getBoundingClientRect();
  const scaleX = BOARD_WIDTH / rect.width;
  const scaleY = BOARD_HEIGHT / rect.height;

  return {
    x: clamp(Math.round((event.clientX - rect.left) * scaleX), 0, BOARD_WIDTH),
    y: clamp(Math.round((event.clientY - rect.top) * scaleY), 0, BOARD_HEIGHT)
  };
}

function openNoteSheet(draft) {
  noteDraft = draft;
  noteText.value = draft.text;
  saveNoteButton.textContent = draft.mode === "edit" ? "Speichern" : "Notiz hinzufügen";
  noteSheet.classList.add("is-open");
  noteSheet.setAttribute("aria-hidden", "false");
  window.setTimeout(() => noteText.focus(), 80);
}

function closeNoteSheet() {
  noteDraft = null;
  noteText.value = "";
  noteSheet.classList.remove("is-open");
  noteSheet.setAttribute("aria-hidden", "true");
}

function renderModeHint() {
  const hints = {
    select: selectedIds.size ? `${selectedIds.size} ausgewählt` : "Rahmen um Objekte ziehen",
    note: "Auf die Fläche tippen, um eine Notiz zu setzen",
    draw: "Mit Finger oder Maus zeichnen"
  };

  modeHint.textContent = hints[currentTool];
}

function renderSelectionActions() {
  const object = getSingleSelectedObject();

  editButton.disabled = object?.type !== "text";
  deleteButton.disabled = selectedIds.size === 0;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  return element;
}

function wrapText(text, maxLength) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;

    if (next.length > maxLength) {
      if (line) {
        lines.push(line);
      }
      line = word;
    } else {
      line = next;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function simplifyPoints(points) {
  return points.filter((point, index) => index === 0 || index % 2 === 0 || index === points.length - 1);
}

function renderSelectionPreview() {
  render();

  if (!selectionState) {
    return;
  }

  const box = normalizeSelectionBox(selectionState);

  if (box.width < 3 && box.height < 3) {
    return;
  }

  board.append(
    svgElement("rect", {
      class: "selection-rect",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height
    })
  );
}

function findObjectsInSelection(selection) {
  const box = normalizeSelectionBox(selection);

  if (box.width < 12 || box.height < 12) {
    return [];
  }

  return state.objects.filter((object) => {
    const bounds = getObjectBounds(object);
    return bounds && rectsOverlap(box, bounds);
  });
}

function getObjectBounds(object) {
  if (object.type === "text") {
    const lines = wrapText(object.text, 18);

    return {
      x: object.x,
      y: object.y,
      width: 210,
      height: Math.max(74, lines.length * 20 + 34)
    };
  }

  if (object.type === "stroke" && object.points.length > 0) {
    const xs = object.points.map(([x]) => x);
    const ys = object.points.map(([, y]) => y);
    const pad = Math.max(8, object.width ?? 4);

    return {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      width: Math.max(...xs) - Math.min(...xs) + pad * 2,
      height: Math.max(...ys) - Math.min(...ys) + pad * 2
    };
  }

  return null;
}

function normalizeSelectionBox(selection) {
  const x = Math.min(selection.start.x, selection.current.x);
  const y = Math.min(selection.start.y, selection.current.y);
  const width = Math.abs(selection.current.x - selection.start.x);
  const height = Math.abs(selection.current.y - selection.start.y);

  return { x, y, width, height };
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function clampNotePosition(x, y) {
  return {
    x: clamp(Math.round(x), 0, BOARD_WIDTH - 210),
    y: clamp(Math.round(y), 0, BOARD_HEIGHT - 74)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getActionText(op) {
  const labels = {
    [EVENT_TYPES.CREATE_TEXT]: "Notiz erstellt",
    [EVENT_TYPES.EDIT_TEXT]: "Notiz bearbeitet",
    [EVENT_TYPES.MOVE]: "Notiz verschoben",
    [EVENT_TYPES.DELETE]: "Objekt gelöscht",
    [EVENT_TYPES.DRAW_STROKE]: "Gezeichnet"
  };

  return labels[op] || op.replaceAll("_", " ");
}

function getSingleSelectedObject() {
  if (selectedIds.size !== 1) {
    return null;
  }

  const [id] = selectedIds;
  return state.objects.find((object) => object.id === id);
}

function getOrCreateAuthor() {
  const key = "dpi-whiteboard-author";
  const existing = localStorage.getItem(key);

  if (existing) {
    return existing;
  }

  const generated = `peer-${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem(key, generated);
  return generated;
}
