export {};
/**
 * status CLI — connect and print a snapshot: world summary, last 5 chat
 * messages, online users, combat state.
 *
 * Usage:
 *   bun run src/cli/status.ts
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { FoundryLive } = await import("../live.js");

async function main(): Promise<void> {
  const live = await FoundryLive.connect();
  try {
    const summary = live.getWorldSummary();
    const chat = live.getChatMessages(5);
    const users = live.getUsers();
    const combat = live.getCombatState();
    const out = {
      world: summary,
      chat: chat.map((m) => ({
        id: m.id,
        author: m.author,
        speaker: m.speaker,
        content: m.content,
        timestamp: m.timestamp,
      })),
      users: users.map((u) => ({ id: u._id, name: u.name, role: u.role, active: u.active })),
      combat: combat ? combat : null,
      me: live.userId,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`status failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
