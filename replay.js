export const EVENT_TYPES = Object.freeze({
  CREATE_TEXT: "create_text",
  EDIT_TEXT: "edit_text",
  MOVE: "move",
  DELETE: "delete",
  DRAW_STROKE: "draw_stroke"
});

export function compareEvents(a, b) {
  return (
    Number(a.time ?? 0) - Number(b.time ?? 0) ||
    String(a.author ?? "").localeCompare(String(b.author ?? "")) ||
    Number(a.seq ?? 0) - Number(b.seq ?? 0) ||
    String(a.eventId ?? "").localeCompare(String(b.eventId ?? ""))
  );
}

export function replayEvents(events) {
  const objects = new Map();
  const tombstones = new Set();
  const orderedEvents = [...events].sort(compareEvents);

  for (const event of orderedEvents) {
    const objectId = event.objectId;

    if (!objectId) {
      continue;
    }

    if (event.op === EVENT_TYPES.DELETE) {
      objects.delete(objectId);
      tombstones.add(objectId);
      continue;
    }

    if (tombstones.has(objectId)) {
      continue;
    }

    if (event.op === EVENT_TYPES.CREATE_TEXT) {
      if (objects.has(objectId)) {
        continue;
      }

      objects.set(objectId, {
        id: objectId,
        type: "text",
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        text: String(event.text ?? ""),
        author: event.author,
        createdAt: event.time,
        updatedAt: event.time
      });
      continue;
    }

    if (event.op === EVENT_TYPES.DRAW_STROKE) {
      if (objects.has(objectId)) {
        continue;
      }

      objects.set(objectId, {
        id: objectId,
        type: "stroke",
        points: normalizePoints(event.points),
        color: event.color || "#111111",
        width: Number(event.width ?? 4),
        author: event.author,
        createdAt: event.time,
        updatedAt: event.time
      });
      continue;
    }

    const object = objects.get(objectId);

    if (!object) {
      continue;
    }

    if (event.op === EVENT_TYPES.MOVE) {
      object.x = Number(event.x ?? object.x ?? 0);
      object.y = Number(event.y ?? object.y ?? 0);
      object.updatedAt = event.time;
      continue;
    }

    if (event.op === EVENT_TYPES.EDIT_TEXT && object.type === "text") {
      object.text = String(event.text ?? object.text);
      object.updatedAt = event.time;
    }
  }

  return {
    objects: [...objects.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    activity: orderedEvents
  };
}

export function normalizePoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([x, y]) => [Number(x), Number(y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

export function createEventFactory(author, initialSeq = 0) {
  let seq = initialSeq;

  return function createEvent(op, payload = {}) {
    seq += 1;
    const time = Date.now();

    return {
      eventId: `${author}:${seq}`,
      author,
      seq,
      time,
      op,
      ...payload
    };
  };
}
