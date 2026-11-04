// deploy/vm/copy-redis.js
//
// One-off: copies what's in the old Upstash Redis (SRC) into the VM's own Redis
// (DEST), keeping each key's expiry. deploy.sh runs it once, inside the API
// container (which has ioredis), after the API and the bot have both switched
// over. A key that already exists in DEST is skipped: it was written since the
// switch, so it's newer than Upstash's copy.
//
// Copied by type rather than with DUMP/RESTORE, because a DUMP from Upstash
// isn't guaranteed to load into another Redis version.

const { Redis } = require("ioredis");

const src = new Redis(process.env.SRC, { maxRetriesPerRequest: 2 });
const dest = new Redis(process.env.DEST, { maxRetriesPerRequest: 2 });

async function copyKey(key) {
  const ttl = await src.pttl(key);
  if (ttl === -2) return "gone"; // expired while scanning
  if (await dest.exists(key)) return "skipped";
  const type = await src.type(key);
  switch (type) {
    case "string": {
      const v = await src.getBuffer(key);
      if (v === null) return "gone";
      await dest.set(key, v);
      break;
    }
    case "hash": {
      const v = await src.hgetallBuffer(key);
      if (!Object.keys(v).length) return "gone";
      await dest.hset(key, v);
      break;
    }
    case "list": {
      const v = await src.lrangeBuffer(key, 0, -1);
      if (!v.length) return "gone";
      await dest.rpush(key, ...v);
      break;
    }
    case "set": {
      const v = await src.smembersBuffer(key);
      if (!v.length) return "gone";
      await dest.sadd(key, ...v);
      break;
    }
    case "zset": {
      const v = await src.zrangeBuffer(key, 0, -1, "WITHSCORES");
      if (!v.length) return "gone";
      const args = [];
      for (let i = 0; i < v.length; i += 2) args.push(v[i + 1].toString(), v[i]);
      await dest.zadd(key, ...args);
      break;
    }
    case "none":
      return "gone";
    default:
      return `unsupported:${type}`;
  }
  if (ttl > 0) await dest.pexpire(key, ttl);
  return "copied";
}

(async () => {
  const counts = {};
  let cursor = "0";
  do {
    const [next, keys] = await src.scanBuffer(cursor, "COUNT", 500);
    cursor = next.toString();
    for (const key of keys) {
      let result;
      try {
        result = await copyKey(key);
      } catch (err) {
        result = `failed:${String(err.message).split(" ")[0]}`;
      }
      counts[result] = (counts[result] || 0) + 1;
    }
  } while (cursor !== "0");
  // Counts only: key names can contain user and server IDs.
  console.log("Redis copy from Upstash:", JSON.stringify(counts));
  await Promise.all([src.quit(), dest.quit()]);
})().catch(async (err) => {
  console.error("Redis copy from Upstash failed:", err.message);
  src.disconnect();
  dest.disconnect();
  process.exit(1);
});
