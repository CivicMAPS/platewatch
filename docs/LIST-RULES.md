# PlateWatch — list ownership and import rules

Source: owner decision OQ26-5 (23/11/2026, wireframes WF-S26/S27) and the CivicMAPS integration
brief. Code: `src/lib/listPolicy.ts` (pure functions, tested in `tests/listPolicy.test.ts`).

## Where a list comes from

Every list carries `source` (`src/lib/types.ts`):

| Origin | How it is made | Shown as |
|---|---|---|
| `system` | Created or updated by an import (`planImport`). In EnforcementMAPS: published from the CommandMAPS dashboard. | `SYSTEM` tag + "Imported from <file> · <date>" |
| `officer` | Created on the device (`listForm`). Records the local day it was made (`serviceDay`). | "Officer list · created <date>" |

Lists saved before `source` existed count as undated officer lists. Backups keep `source`; a
malformed one is dropped on restore.

## Rules by build

The build sets the mode: `VITE_PLATEWATCH_MODE=enforcementmaps`. Anything else, including unset,
is **development**, so a typo can never lock officers out during field testing.

| | Development (now) | EnforcementMAPS (after integration) |
|---|---|---|
| Import lists from a file | Yes, on the device | No: done in **CommandMAPS** by team leaders and parking services management with import authorisation (`canImportInCommandMaps`) |
| Create lists | Timed, non-timed permit zone, hot, allow | Officers: timed only (daily digital chalking lists) |
| Paid parking on a list made on the device | Yes | No: officer lists are for segments with time restrictions that are not linked to paid parking |
| Edit / delete a system list | Yes (form shows a "System list — editable in this development build" notice) | No: ✎ and Delete are hidden; a read-only notice is shown |
| Edit / delete an officer list | Yes | Yes, on the day it was created |
| Officer list after its day | Kept | Hidden from Home; read-only if opened (boundary: local midnight) |

## Plate tags (known disability / emergency vehicles)

| | Development (now) | EnforcementMAPS |
|---|---|---|
| Remove a tag | Settings → Tagged vehicles, or Dismiss at a vehicle check | Dismiss at a vehicle check; otherwise CommandMAPS operational dashboard, supervisors and above with parking services branch authority (`canRemoveTagsInCommandMaps`) |

See `docs/PERMITS-AND-EXEMPTIONS.md`.

## Still open (Sequence 29)

- Expiry boundary: local midnight (implemented) or end of shift.
- What happens to sightings and evidence recorded on an expired officer list (retained under the
  retention setting; the list is hidden).
- The "report missing restrictions" path for system placeholder segments (OQ26-14). The scan
  result still says "Add them under Edit list", which is right for development but not for
  EnforcementMAPS.
- The role and authorisation come from the EnforcementMAPS operating context; standalone
  PlateWatch has no sign-in, so an EnforcementMAPS build assumes the user is an officer.
