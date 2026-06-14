import { createSnapshot, listSnapshots, restoreSnapshot, syncPublicAssets } from "./version-store.mjs";

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case "create": {
      const reason = args.join(" ").trim() || "manual";
      const snapshot = await createSnapshot(reason);
      console.log(`Created snapshot ${snapshot.id} (${snapshot.reason})`);
      break;
    }
    case "list": {
      const snapshots = await listSnapshots();
      if (snapshots.length === 0) {
        console.log("No snapshots found.");
        break;
      }

      for (const snapshot of snapshots) {
        console.log(`${snapshot.id}\t${snapshot.createdAt}\t${snapshot.reason}`);
      }
      break;
    }
    case "restore": {
      const id = args[0];
      if (!id) {
        throw new Error("Snapshot id is required.");
      }
      const snapshot = await restoreSnapshot(id);
      console.log(`Restored snapshot ${snapshot.id}`);
      break;
    }
    case "sync": {
      await syncPublicAssets();
      console.log("Synced current assets to public/assets.");
      break;
    }
    default:
      console.log("Usage:");
      console.log("  npm run snapshot:create -- [reason]");
      console.log("  npm run snapshot:list");
      console.log("  npm run snapshot:restore -- <snapshot-id>");
      console.log("  npm run sync:assets");
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
