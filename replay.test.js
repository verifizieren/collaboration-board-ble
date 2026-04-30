import assert from "node:assert/strict";
import { EVENT_TYPES, replayEvents } from "../src/replay.js";

const aliceCreate = {
  eventId: "alice:1",
  author: "alice",
  seq: 1,
  time: 1,
  op: EVENT_TYPES.CREATE_TEXT,
  objectId: "alice:note:1",
  x: 20,
  y: 30,
  text: "Initial"
};

const bobMove = {
  eventId: "bob:1",
  author: "bob",
  seq: 1,
  time: 2,
  op: EVENT_TYPES.MOVE,
  objectId: "alice:note:1",
  x: 80,
  y: 120
};

const aliceEdit = {
  eventId: "alice:2",
  author: "alice",
  seq: 2,
  time: 3,
  op: EVENT_TYPES.EDIT_TEXT,
  objectId: "alice:note:1",
  text: "Updated"
};

const shuffledState = replayEvents([aliceEdit, bobMove, aliceCreate]);

assert.equal(shuffledState.objects.length, 1);
assert.deepEqual(shuffledState.objects[0], {
  id: "alice:note:1",
  type: "text",
  x: 80,
  y: 120,
  text: "Updated",
  author: "alice",
  createdAt: 1,
  updatedAt: 3
});

const deletedState = replayEvents([
  aliceCreate,
  aliceEdit,
  {
    eventId: "bob:2",
    author: "bob",
    seq: 2,
    time: 4,
    op: EVENT_TYPES.DELETE,
    objectId: "alice:note:1"
  },
  {
    eventId: "alice:3",
    author: "alice",
    seq: 3,
    time: 5,
    op: EVENT_TYPES.MOVE,
    objectId: "alice:note:1",
    x: 500,
    y: 500
  }
]);

assert.equal(deletedState.objects.length, 0);

const strokeState = replayEvents([
  {
    eventId: "bob:3",
    author: "bob",
    seq: 3,
    time: 6,
    op: EVENT_TYPES.DRAW_STROKE,
    objectId: "bob:stroke:1",
    points: [[1, 2], ["3", "4"], ["bad", 8]],
    color: "#111111",
    width: 3
  }
]);

assert.deepEqual(strokeState.objects[0].points, [[1, 2], [3, 4]]);

console.log("replay tests passed");
