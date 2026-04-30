import { APP_ID, BOARD_ID } from "./config.js";

export function createTremolaAdapter() {
  const bridge = window.tremolaWhiteboardStore;

  return {
    name: "tinySSB",
    isAvailable: Boolean(bridge),
    async appendEvent(event) {
      if (!bridge) {
        throw new Error("Tremola bridge is not available.");
      }

      await bridge.appendEvent({ appId: APP_ID, boardId: BOARD_ID, event });
      return this.loadEvents();
    },
    async loadEvents() {
      if (!bridge) {
        return [];
      }

      return bridge.loadEvents({ appId: APP_ID, boardId: BOARD_ID });
    }
  };
}
