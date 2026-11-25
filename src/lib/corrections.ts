import { db, uid } from './db';
import { evaluate, newObservation, resighting } from './engine';
import { normalisePlate, isValidPlate } from './plate';
import type { Observation, ScanRecord } from './types';

/** Amend the record and repair both affected sighting histories in one transaction. */
export async function correctRecord(id: string, input: string, expectedPlate: string) {
  const plate = normalisePlate(input);
  if (!isValidPlate(plate)) throw new Error('Enter a valid plate.');
  const tx = (await db()).transaction(['scans','observations','lists'], 'readwrite');
  const scans = tx.objectStore('scans');
  const obs = tx.objectStore('observations');
  const s = await scans.get(id);
  if (!s || s.plate !== expectedPlate) throw new Error('Record changed. Reopen it to edit.');
  if (s.plate === plate) return;
  const lists = await tx.objectStore('lists').getAll();
  const list = lists.find(l => l.id === s.listId);
  if (!list) throw new Error('List unavailable.');
  const at = s.meta.capturedAt;
  const histories = await obs.index('by-list').getAll(list.id);
  const eligible = histories.filter(o => o.plate === plate && o.windowEndsAt > at && (!o.closedAt || o.closedAt > at));
  const result = evaluate({at, plate, list, hotLists: lists.filter(l => l.type === 'hot'),
    allowLists: lists.filter(l => l.type === 'allow'), observations: eligible.filter(o => o.startedAt <= at).map(o => ({...o,status:'active'}))});
  // A permit pop-up cannot be asked again here: a permit applying here keeps the record exempt;
  // otherwise the timing behind it applies.
  let decision = result.decision;
  while (decision.kind === 'timed_permit' || decision.kind === 'timed_flag_check')
    decision = decision.kind === 'timed_permit' && decision.hits[0]?.validity === 'valid' && decision.hits[0].scope === 'applies' ? { kind: 'timed_exempt', hit: decision.hits[0] } : decision.then;
  let target: Observation | undefined;
  if (decision.kind === 'timed_resighting') target = histories.find(o => o.id === decision.observation.id);
  if ((decision.kind === 'timed_new' || decision.kind === 'timed_possible') && list.type === 'timed') {
    target = eligible.find(o => o.windowEndsAt === decision.instance.end && o.startedAt >= at)
      ?? newObservation({id:uid(),list,plate,scanId:id,at,instance:decision.instance});
  }
  const previousId = s.observationId;
  const revisions = [...(s.revisions ?? []), {at:Date.now(),plate:s.plate,outcome:s.outcome}];
  const amended: ScanRecord = {...s, plate,key:plate,corrected:true,revisions,observationId:target?.id ?? null,
    outcome:target ? 'recorded' : decision.kind === 'timed_exempt' ? 'permit_valid' : decision.kind === 'hot_match' && result.hotHits.some(h => h.strength === 'exact' && h.list.id === list.id) ? 'hot_sighting' : 'reviewed',
    amendmentResult:decision.kind, amendmentMatches:result.hotHits.map(h => h.entry.plate+' · '+h.list.name+' · '+h.strength)};
  if (list.type === 'permit_zone') {
    // Changing the plate invalidates the officer's confirmation for the original vehicle.
    delete amended.exemption;
    amended.outcome = 'permit_unconfirmed';
  }
  await scans.put(amended);
  for (const group of [histories.find(o => o.id === previousId),target]) {
    if (!group) continue;
    const rows = (await scans.index('by-observation').getAll(group.id)).sort((a,b) => a.meta.capturedAt-b.meta.capturedAt || a.createdAt-b.createdAt);
    if (!rows.length) { await obs.delete(group.id); continue; }
    const first = rows[0]!;
    const startedAt = first.meta.capturedAt;
    const updated = {...group,startedAt,allowanceEndsAt:startedAt + group.allowanceEndsAt-group.startedAt,
      firstScanId:first.id,lastScanId:rows[rows.length-1]!.id,scanCount:rows.length,overstayFlaggedAt:null as number|null};
    for (const row of rows) {
      const outcome = row.id === first.id ? 'recorded' : resighting(updated,row.meta.capturedAt).overstay ? 'overstay' : 'within_allowance';
      if (outcome === 'overstay') updated.overstayFlaggedAt ??= row.meta.capturedAt;
      if (row.outcome !== outcome) await scans.put({...row,outcome});
    }
    await obs.put(updated);
  }
  await tx.done;
}
