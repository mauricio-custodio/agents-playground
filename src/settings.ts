// Settings that REPL commands change while you chat.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// One shared object, so a change made by a command is seen by every module.
export const settings = {
  effort: "low" as Effort,
  showRaw: false,
};

export function setEffort(value: string | undefined) {
  if (EFFORTS.includes(value as Effort)) settings.effort = value as Effort;
  else if (value) console.log(`unknown effort "${value}"`);
  console.log(`effort: ${settings.effort}  (options: ${EFFORTS.join(", ")})`);
}

export function toggleRaw() {
  settings.showRaw = !settings.showRaw;
  console.log(`raw view ${settings.showRaw ? "on" : "off"}`);
}
