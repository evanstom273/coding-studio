/** The cloud sync's decision about each file (pure, so it can be tested). */

/**
 * Which files go up (push) and which come down (pull; a pull of a file the cloud doesn't have
 * deletes it here). `base` is what both sides last agreed on, null if unknown. A file is only
 * ever deleted on one side when the base shows it existed before, so a first sync, or one that
 * stopped partway, can only add files, never remove them.
 */
export function planSync(local: Map<string, string> | undefined, cloud: Map<string, string> | undefined, base: Record<string, string> | null, localNewer: boolean) {
  const push: string[] = [];
  const pull: string[] = [];
  let conflicts = 0;
  const paths = new Set([...(local?.keys() ?? []), ...(cloud?.keys() ?? [])]);
  for (const p of paths) {
    const l = local?.get(p);
    const c = cloud?.get(p);
    if (l === c) continue;
    const b = base?.[p];
    if (base && l === b) pull.push(p);
    else if (base && c === b) push.push(p);
    else if (!cloud) push.push(p);
    else if (!local) pull.push(p);
    else if (l === undefined) pull.push(p);
    else if (c === undefined) push.push(p);
    else if (!base) (localNewer ? push : pull).push(p);
    else {
      pull.push(p); // changed on both sides: the cloud wins
      conflicts++;
    }
  }
  return { push, pull, conflicts };
}
