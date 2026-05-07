const delayMs = Number(process.env.FAKE_AGENT_DELAY_MS ?? "1500");

process.stdout.write("# Delayed Stdout Agent\n\n");
process.stdout.write("stream-start\n");

setTimeout(() => {
  process.stdout.write("stream-end\n");
  process.exit(0);
}, delayMs);
