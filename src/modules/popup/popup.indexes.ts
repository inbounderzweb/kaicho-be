import { Popup } from "../../database/models";

// Same explicit-at-boot index build as the other admin-content modules.
export async function ensurePopupIndexes(): Promise<void> {
  await Popup.createIndexes();
  console.log("[popup] indexes ensured (status+priority)");
}
