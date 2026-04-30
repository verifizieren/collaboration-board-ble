import { APP_ID } from "./config.js";
import { createTremolaAdapter } from "./tremola-adapter.js";

const STORAGE_KEY = `${APP_ID}:events`;
const LEGACY_STORAGE_KEY = "dpi-whiteboard-events";

export function loadEvents() {
  try {
    const rawEvents = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    return rawEvents ? JSON.parse(rawEvents) : [];
  } catch {
    return [];
  }
}

export function saveEvents(events) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

export function clearEvents() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function appendLocalEvent(event) {
  const events = loadEvents();
  const exists = events.some((candidate) => candidate.eventId === event.eventId);

  if (!exists) {
    events.push(event);
    saveEvents(events);
  }

  return events;
}

export function createEventStore() {
  const tremola = createTremolaAdapter();
  return tremola.isAvailable ? tremola : createLocalStore();
}

function createLocalStore() {
  return {
    name: "localStorage",
    async loadEvents() {
      return loadEvents();
    },
    async appendEvent(event) {
      return appendLocalEvent(event);
    }
  };
}
